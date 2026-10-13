import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../packages/database/src/migrate.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { createApp } from '../../apps/api/src/app.js';
import { ExecutionService, type AgentIdentity } from '../../apps/api/src/execution-service.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';

const schema = `policy_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let root: string;
let control: ControlPlane;
let execution: ExecutionService;
let app: Awaited<ReturnType<typeof createApp>>;
let f: Awaited<ReturnType<typeof fixture>>;
let agent: AgentIdentity;
let project: { id: string };
let v1: { id: string; artifact_id: string; manifest: { artifact: { digest: string } } };
let v2: typeof v1;

async function post(path: string, payload: unknown, token = f.operator.token, key = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
      'content-type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json',
    },
    payload: payload as never,
  });
}

async function get(path: string, token = f.operator.token) {
  return app.inject({
    method: 'GET',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function processDefinition() {
  const process = deploymentProcess();

  Object.assign(process.spec.artifact, { dockerImageId: `sha256:${'a'.repeat(64)}` });

  for (const env of Object.values(process.spec.environments)) {
    Object.assign(env, { strategy: 'recreate', verify: { http: { path: '/' } } });
  }

  return process;
}

async function release(version: string) {
  const bytes = Buffer.from(`retained image ${version}`);

  const query = new URLSearchParams({
    project_id: project.id,
    name: 'application',
    version,
    digest: sha256(bytes),
  });

  const artifact = await post(`/artifacts?${query}`, bytes);

  expect(artifact.statusCode).toBe(200);

  const result = await post('/releases', {
    project_id: project.id,
    artifact_id: artifact.json().id,
    version,
    process: processDefinition(),
  });

  expect(result.statusCode).toBe(200);

  return result.json() as typeof v1;
}

async function policy(
  environment: string,
  prerequisite: string | null,
  revision = 1,
  token = f.approver.token,
) {
  return post(
    `/environments/${environment}/promotion-policy`,
    {
      promotion_from_environment_id: prerequisite,
      expected_revision: revision,
    },
    token,
  );
}

async function finish(releaseId: string, environment: string, success = true) {
  const response = await post('/deployments', {
    release_id: releaseId,
    environment_id: environment,
  });

  expect(response.statusCode, response.body).toBe(200);
  const deployment = response.json();

  if (deployment.status === 'awaiting_approval') {
    expect(
      (await post(`/deployments/${deployment.id}/approve`, {}, f.approver.token)).statusCode,
    ).toBe(200);
  }

  await execution.tick(f.org, deployment.id);
  const job = (await execution.claim(agent))!;

  expect(job).not.toBeNull();

  await execution.complete(agent, {
    attempt_id: job.attempt_id,
    fence: job.fence,
    token: job.token,
    outcome: success ? 'succeeded' : 'failed',
    code: success ? 'HTTP_VERIFIED' : 'HEALTH_FAILED',
  });

  return deployment;
}

async function history() {
  const staging = await finish(v1.id, f.environments.staging);
  const previous = await finish(v1.id, f.environments.production);

  await finish(v2.id, f.environments.staging);
  const current = await finish(v2.id, f.environments.production);

  return { staging, previous, current };
}

async function plan(previous: { id: string }, current: { id: string }) {
  const response = await post('/rollback-plans', {
    source_deployment_id: current.id,
    candidate_deployment_id: previous.id,
  });

  expect(response.statusCode, response.body).toBe(200);

  return response.json();
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-policy-'));
  control = new ControlPlane(db, new LocalArtifactStore(root));
  execution = new ExecutionService(control);
});

beforeEach(async () => {
  f = await fixture(db);
  app = await createApp(control);
  project = (await post('/projects', { name: 'Delivery policy', slug: 'delivery' })).json();
  v1 = await release('1');
  v2 = await release('2');
  const fingerprint = randomBytes(32).toString('hex');

  expect(
    (await post('/agents', { name: 'Private host', certificate_fingerprint: fingerprint }))
      .statusCode,
  ).toBe(200);

  agent = await execution.authenticate(fingerprint);

  for (const [slug, environment] of Object.entries(f.environments)) {
    expect(
      (
        await post('/targets', {
          name: slug,
          project_id: project.id,
          environment_id: environment,
          agent_id: agent.id,
          labels: { tier: slug },
        })
      ).statusCode,
    ).toBe(200);
  }

  expect((await policy(f.environments.production, f.environments.staging)).statusCode).toBe(200);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

describe('Promotion admission', () => {
  it('checks promotion and requests a reviewed rollback through the CLI', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const run = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', 'apps/cli/src/main.ts', ...args],
        { env: { ...process.env, KEEL_URL: address, KEEL_TOKEN: f.operator.token } },
      );

      return JSON.parse(stdout);
    };

    expect(
      await run(
        'deployment',
        'promotion',
        '--release',
        v1.id,
        '--environment',
        f.environments.production,
      ),
    ).toMatchObject({ eligible: false });

    const { previous, current } = await history();

    expect(
      await run(
        'deployment',
        'promotion',
        '--release',
        v1.id,
        '--environment',
        f.environments.production,
      ),
    ).toMatchObject({ eligible: true, requires_approval: true });

    const candidates = await run('deployment', 'rollback-candidates', current.id);

    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0].deployment_id).toBe(previous.id);

    const reviewed = await run(
      'rollback',
      'plan',
      '--from',
      current.id,
      '--candidate',
      previous.id,
    );

    await expect(run('rollback', 'request', reviewed.id)).rejects.toThrow(
      '--acknowledge-data-not-restored',
    );

    const requested = await run(
      'rollback',
      'request',
      reviewed.id,
      '--acknowledge-data-not-restored',
    );

    expect(requested).toMatchObject({
      release_id: v1.id,
      kind: 'rollback',
      rollback_plan_id: reviewed.id,
      status: 'awaiting_approval',
    });

    expect(
      (await db.query('SELECT 1 FROM deployment_attempts WHERE deployment_id=$1', [requested.id]))
        .rowCount,
    ).toBe(0);
  });

  it('requires verified execution of this exact immutable release and records the evidence', async () => {
    const input = { release_id: v1.id, environment_id: f.environments.production };

    expect((await post('/deployments', input)).json().error.code).toBe('PROMOTION_REQUIRED');

    const eligibility = await get(
      `/releases/${v1.id}/promotion?environment_id=${f.environments.production}`,
    );

    expect(eligibility.json()).toMatchObject({
      eligible: false,
      promotion_from_environment_id: f.environments.staging,
      requires_approval: true,
    });

    await finish(v1.id, f.environments.staging, false);
    expect((await post('/deployments', input)).json().error.code).toBe('PROMOTION_REQUIRED');
    const verified = await finish(v1.id, f.environments.staging);

    expect((await post('/deployments', { ...input, release_id: v2.id })).json().error.code).toBe(
      'PROMOTION_REQUIRED',
    );

    const changedProcess = await post('/releases', {
      project_id: project.id,
      artifact_id: v1.artifact_id,
      version: 'same-bytes-new-process',
      process: processDefinition(),
    });

    expect(
      (await post('/deployments', { ...input, release_id: changedProcess.json().id })).json().error
        .code,
    ).toBe('PROMOTION_REQUIRED');

    const response = await post('/deployments', input);

    expect(response.statusCode).toBe(200);

    expect(response.json()).toMatchObject({
      status: 'awaiting_approval',
      kind: 'deploy',
      promotion_source_deployment_id: verified.id,
      policy_snapshot: {
        revision: 2,
        promotion_from_environment_id: f.environments.staging,
        requires_approval: true,
      },
    });

    expect(
      (
        await get(`/releases/${v1.id}/promotion?environment_id=${f.environments.production}`)
      ).json(),
    ).toMatchObject({
      eligible: true,
      source_deployment_id: verified.id,
      digest: v1.manifest.artifact.digest,
    });
  });

  it('does not accept a status-only success without a verified agent attempt', async () => {
    const response = await post('/deployments', {
      release_id: v1.id,
      environment_id: f.environments.staging,
    });

    await db.query(
      "UPDATE deployments SET status='succeeded', result_code='HTTP_VERIFIED' WHERE id=$1",
      [response.json().id],
    );

    const blocked = await post('/deployments', {
      release_id: v1.id,
      environment_id: f.environments.production,
    });

    expect(blocked.json().error.code).toBe('PROMOTION_REQUIRED');
  });

  it('restricts policy edits to approvers and prevents foreign references, cycles and stale updates', async () => {
    expect((await policy(f.environments.production, null, 2, f.operator.token)).statusCode).toBe(
      403,
    );

    expect((await policy(f.environments.production, null, 2, f.reader.token)).statusCode).toBe(403);
    const other = await fixture(db);

    expect(
      (await policy(f.environments.production, other.environments.staging, 2)).statusCode,
    ).toBe(404);

    expect(
      (await policy(f.environments.staging, f.environments.production)).json().error.code,
    ).toBe('POLICY_CYCLE');

    expect((await policy(f.environments.staging, f.environments.staging)).json().error.code).toBe(
      'POLICY_CYCLE',
    );

    expect((await policy(f.environments.production, null, 1)).json().error.code).toBe(
      'POLICY_CHANGED',
    );

    expect((await policy(f.environments.production, null, 2)).statusCode).toBe(200);
    expect((await policy(f.environments.staging, f.environments.production)).statusCode).toBe(200);
  });

  it('serializes concurrent policy edits and freezes the policy on admitted deployments', async () => {
    expect((await policy(f.environments.production, null, 2)).statusCode).toBe(200);

    const response = await post('/deployments', {
      release_id: v1.id,
      environment_id: f.environments.production,
    });

    expect(response.statusCode).toBe(200);

    const results = await Promise.all([
      policy(f.environments.production, f.environments.staging, 3),
      policy(f.environments.staging, f.environments.production, 1),
    ]);

    expect(results.map((item) => item.statusCode).sort()).toEqual([200, 400]);

    expect(
      (await post(`/deployments/${response.json().id}/approve`, {}, f.approver.token)).statusCode,
    ).toBe(200);

    await expect(
      db.query("UPDATE deployments SET policy_snapshot='{}' WHERE id=$1", [response.json().id]),
    ).rejects.toMatchObject({ code: '23514' });

    const other = await fixture(db);

    expect(
      (
        await get(
          `/releases/${v1.id}/promotion?environment_id=${f.environments.production}`,
          other.reader.token,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('Retained-release rollback plans', () => {
  it('paginates rollback history after deduplicating verified releases', async () => {
    const previous: string[] = [];

    for (let n = 0; n < 53; n++) {
      const retained = await release(`history-${n}`);
      const deployment = await finish(retained.id, f.environments.staging);

      previous.unshift(deployment.id);
    }

    // A repeated verification must not leak a second copy onto an older page.
    await finish(v1.id, f.environments.staging);
    const latestV1 = await finish(v1.id, f.environments.staging);

    previous.unshift(latestV1.id);
    const current = await finish(v2.id, f.environments.staging);
    const first = await get(`/deployments/${current.id}/rollback-candidates`);

    expect(first.statusCode).toBe(200);
    expect(first.json().candidates).toHaveLength(50);

    const second = await get(
      `/deployments/${current.id}/rollback-candidates?cursor=${first.json().next_cursor}`,
    );

    expect(second.statusCode).toBe(200);
    expect(second.json().next_cursor).toBeNull();

    expect(
      [...first.json().candidates, ...second.json().candidates].map(
        (row: { deployment_id: string }) => row.deployment_id,
      ),
    ).toEqual(previous);

    for (const cursor of ['-1', 'invalid', '9223372036854775808', '1.5']) {
      expect(
        (await get(`/deployments/${current.id}/rollback-candidates?cursor=${cursor}`)).statusCode,
      ).toBe(400);
    }
  });

  it('plans and requests a pinned rollback with approval, immutable evidence and normal fenced execution', async () => {
    const { previous, current, staging } = await history();
    const candidates = await get(`/deployments/${current.id}/rollback-candidates`);

    expect(candidates.json().candidates).toHaveLength(1);

    expect(candidates.json().candidates[0]).toMatchObject({
      deployment_id: previous.id,
      release_id: v1.id,
    });

    const reviewed = await plan(previous, current);

    expect(reviewed).toMatchObject({
      release_id: v1.id,
      expected_fence: 2,
      requires_approval: true,
      digest: v1.manifest.artifact.digest,
      promotion_source_deployment_id: staging.id,
    });

    const payload = { acknowledge_data_not_restored: true };

    expect((await post(`/rollback-plans/${reviewed.id}/request`, {})).statusCode).toBe(400);
    const key = randomUUID();

    const request = await post(
      `/rollback-plans/${reviewed.id}/request`,
      payload,
      f.operator.token,
      key,
    );

    expect(request.statusCode, request.body).toBe(200);
    const deployment = request.json();

    expect(deployment).toMatchObject({
      kind: 'rollback',
      release_id: v1.id,
      rollback_plan_id: reviewed.id,
      status: 'awaiting_approval',
      promotion_source_deployment_id: staging.id,
    });

    expect(
      (await post(`/rollback-plans/${reviewed.id}/request`, payload, f.operator.token, key)).json()
        .id,
    ).toBe(deployment.id);

    expect((await post(`/rollback-plans/${reviewed.id}/request`, payload)).json().error.code).toBe(
      'PLAN_USED',
    );

    expect(
      (await post(`/deployments/${deployment.id}/approve`, {}, f.operator.token)).statusCode,
    ).toBe(403);

    expect(
      (await post(`/deployments/${deployment.id}/approve`, {}, f.approver.token)).statusCode,
    ).toBe(200);

    await execution.tick(f.org, deployment.id);
    const job = (await execution.claim(agent))!;

    expect(job.target_id).toBe(reviewed.target_id);
    expect(job.fence).toBe(3);

    await execution.complete(agent, {
      attempt_id: job.attempt_id,
      fence: job.fence,
      token: job.token,
      outcome: 'succeeded',
      code: 'HTTP_VERIFIED',
    });

    expect(
      (
        await db.query('SELECT current_release_id FROM deployment_targets WHERE id=$1', [
          job.target_id,
        ])
      ).rows[0].current_release_id,
    ).toBe(v1.id);

    await expect(
      db.query('UPDATE rollback_plans SET expected_fence=999 WHERE id=$1', [reviewed.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps plan creation read-only with respect to deployments and rejects stale target and policy state', async () => {
    const { previous, current } = await history();
    const reviewed = await plan(previous, current);

    expect(
      (await db.query('SELECT id FROM deployments WHERE rollback_plan_id=$1', [reviewed.id]))
        .rowCount,
    ).toBe(0);

    expect((await policy(f.environments.production, null, 2)).statusCode).toBe(200);

    expect(
      (
        await post(`/rollback-plans/${reviewed.id}/request`, {
          acknowledge_data_not_restored: true,
        })
      ).json().error.code,
    ).toBe('STALE_ROLLBACK');

    const nextPlan = await plan(previous, current);

    await finish(v2.id, f.environments.production);

    expect(
      (
        await post(`/rollback-plans/${nextPlan.id}/request`, {
          acknowledge_data_not_restored: true,
        })
      ).json().error.code,
    ).toBe('STALE_ROLLBACK');
  });

  it('rejects pending environment work, unverified candidates and cross-environment history', async () => {
    const { previous, current, staging } = await history();

    expect(
      (
        await post('/rollback-plans', {
          source_deployment_id: current.id,
          candidate_deployment_id: staging.id,
        })
      ).json().error.code,
    ).toBe('INELIGIBLE_ROLLBACK');

    const reviewed = await plan(previous, current);

    const pending = await post('/deployments', {
      release_id: v2.id,
      environment_id: f.environments.production,
    });

    expect(
      (
        await post(`/rollback-plans/${reviewed.id}/request`, {
          acknowledge_data_not_restored: true,
        })
      ).json().error.code,
    ).toBe('ENVIRONMENT_LOCKED');

    expect(
      (await get(`/deployments/${pending.json().id}/rollback-candidates`)).json().error.code,
    ).toBe('ROLLBACK_UNAVAILABLE');
  });

  it('refuses missing retained bytes even after the plan was reviewed', async () => {
    const { previous, current } = await history();
    const reviewed = await plan(previous, current);

    await unlink(join(root, f.org, v1.manifest.artifact.digest));

    const response = await post(`/rollback-plans/${reviewed.id}/request`, {
      acknowledge_data_not_restored: true,
    });

    expect(response.json().error.code).toBe('ARTIFACT_UNAVAILABLE');

    expect(
      (await db.query('SELECT id FROM deployments WHERE rollback_plan_id=$1', [reviewed.id]))
        .rowCount,
    ).toBe(0);
  });

  it('enforces a newly required prerequisite for rollback candidates', async () => {
    const { previous, current } = await history();
    const qa = randomUUID();

    await db.query(
      `
      INSERT INTO
        environments (
          id,
          organisation_id,
          name,
          slug,
          requires_approval
        )
      VALUES
        ($1, $2, 'QA', 'qa', FALSE)
    `,
      [qa, f.org],
    );

    expect((await policy(f.environments.production, qa, 2)).statusCode).toBe(200);

    const response = await post('/rollback-plans', {
      source_deployment_id: current.id,
      candidate_deployment_id: previous.id,
    });

    expect(response.json().error.code).toBe('PROMOTION_REQUIRED');
  });

  it('expires unrequested plans and rejects automatic target substitution after approval', async () => {
    const { previous, current } = await history();
    const reviewed = await plan(previous, current);
    const expiredId = randomUUID();

    await db.query(
      `
      INSERT INTO
        rollback_plans (
          id,
          organisation_id,
          project_id,
          environment_id,
          source_deployment_id,
          candidate_deployment_id,
          release_id,
          target_id,
          expected_fence,
          policy_revision,
          created_by,
          expires_at
        )
      SELECT
        $2,
        organisation_id,
        project_id,
        environment_id,
        source_deployment_id,
        candidate_deployment_id,
        release_id,
        target_id,
        expected_fence,
        policy_revision,
        created_by,
        now() - interval '1 second'
      FROM
        rollback_plans
      WHERE
        id = $1
    `,
      [reviewed.id, expiredId],
    );

    expect(
      (
        await post(`/rollback-plans/${expiredId}/request`, { acknowledge_data_not_restored: true })
      ).json().error.code,
    ).toBe('PLAN_EXPIRED');

    const response = await post(`/rollback-plans/${reviewed.id}/request`, {
      acknowledge_data_not_restored: true,
    });

    expect(
      (await post(`/deployments/${response.json().id}/approve`, {}, f.approver.token)).statusCode,
    ).toBe(200);

    expect((await post(`/agents/${agent.id}/state`, { state: 'draining' })).statusCode).toBe(200);

    const otherAgent = await post('/agents', {
      name: 'Different host',
      certificate_fingerprint: randomBytes(32).toString('hex'),
    });

    expect(
      (
        await post('/targets', {
          name: 'Different target',
          project_id: project.id,
          environment_id: f.environments.production,
          agent_id: otherAgent.json().id,
          labels: { tier: 'production' },
        })
      ).statusCode,
    ).toBe(200);

    await execution.tick(f.org, response.json().id);

    expect(
      (
        await db.query('SELECT status,result_code FROM deployments WHERE id=$1', [
          response.json().id,
        ])
      ).rows[0],
    ).toEqual({ status: 'failed', result_code: 'ROLLBACK_TARGET_CHANGED' });

    expect(
      (
        await db.query('SELECT id FROM deployment_attempts WHERE deployment_id=$1', [
          response.json().id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('offers an earlier verified release after a failed deployment has finished cleanup', async () => {
    await finish(v1.id, f.environments.staging);
    const previous = await finish(v1.id, f.environments.production);

    await finish(v2.id, f.environments.staging);
    const failed = await finish(v2.id, f.environments.production, false);

    expect((await plan(previous, failed)).release_id).toBe(v1.id);
  });

  it('isolates plans and their history, enforces permissions, and rejects caller-supplied execution metadata', async () => {
    const { previous, current } = await history();
    const reviewed = await plan(previous, current);
    const other = await fixture(db);

    expect(
      (
        await post(
          '/rollback-plans',
          { source_deployment_id: current.id, candidate_deployment_id: previous.id },
          f.reader.token,
        )
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await post(
          `/rollback-plans/${reviewed.id}/request`,
          { acknowledge_data_not_restored: true },
          other.operator.token,
        )
      ).statusCode,
    ).toBe(404);

    expect(
      (await get(`/deployments/${current.id}/rollback-candidates`, other.reader.token)).statusCode,
    ).toBe(409);

    expect(
      (
        await post('/deployments', {
          release_id: v1.id,
          environment_id: f.environments.production,
          rollback_plan_id: reviewed.id,
        })
      ).statusCode,
    ).toBe(400);
  });
});

it('keeps rollback and approval inside token environment scope and redacts prerequisite evidence', async () => {
  const { previous, current, staging } = await history();

  await db.query('UPDATE api_tokens SET environment_ids=$1, project_ids=$2 WHERE actor_id=$3', [
    [f.environments.production],
    [project.id],
    f.operator.id,
  ]);

  await db.query('UPDATE api_tokens SET environment_ids=$1 WHERE actor_id=$2', [
    [f.environments.staging],
    f.approver.id,
  ]);

  expect((await get(`/deployments/${staging.id}/rollback-candidates`)).statusCode).toBe(404);

  expect(
    (
      await post('/rollback-plans', {
        source_deployment_id: current.id,
        candidate_deployment_id: staging.id,
      })
    ).statusCode,
  ).toBe(404);

  const candidates = await get(`/deployments/${current.id}/rollback-candidates`);

  expect(candidates.statusCode, candidates.body).toBe(200);
  expect(candidates.json().candidates[0].deployment_id).toBe(previous.id);
  const reviewed = await plan(previous, current);

  expect(reviewed.promotion_source_deployment_id).toBeNull();

  const request = await post(`/rollback-plans/${reviewed.id}/request`, {
    acknowledge_data_not_restored: true,
  });

  expect(request.statusCode, request.body).toBe(200);

  expect(request.json()).toMatchObject({
    kind: 'rollback',
    status: 'awaiting_approval',
    promotion_source_deployment_id: null,
  });

  expect(request.body).not.toContain(f.environments.staging);

  expect(
    (await post(`/deployments/${request.json().id}/approve`, {}, f.approver.token)).statusCode,
  ).toBe(404);

  await db.query('UPDATE api_tokens SET environment_ids=$1 WHERE actor_id=$2', [
    [f.environments.production],
    f.approver.id,
  ]);

  const approved = await post(`/deployments/${request.json().id}/approve`, {}, f.approver.token);

  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().promotion_source_deployment_id).toBeNull();

  await db.query('UPDATE api_tokens SET environment_ids=$1 WHERE actor_id=$2', [
    [f.environments.staging],
    f.operator.id,
  ]);

  expect(
    (await post(`/rollback-plans/${reviewed.id}/request`, { acknowledge_data_not_restored: true }))
      .statusCode,
  ).toBe(404);
});
