import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../packages/database/src/migrate.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { createApp } from '../../apps/api/src/app.js';
import { ExecutionService, type AgentIdentity } from '../../apps/api/src/execution-service.js';
import { parseRunbook } from '../../packages/deployment-schema/src/index.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';

const schema = `runbooks_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let root: string;
let control: ControlPlane;
let execution: ExecutionService;
let app: Awaited<ReturnType<typeof createApp>>;
let f: Awaited<ReturnType<typeof fixture>>;
let p: Awaited<ReturnType<ControlPlane['authenticate']>>;
let agent: AgentIdentity;
let project: { id: string };
let artifact: { id: string };
let target: { id: string };
let book: { id: string };
let version: { id: string };
const bytes = Buffer.from('retained operational image');

const process = (approval = true) => ({
  apiVersion: 'keel.dev/v1alpha1',
  kind: 'Runbook',
  spec: {
    artifact: { dockerImageId: `sha256:${'a'.repeat(64)}` },
    task: { command: ['/bin/task'], timeoutSeconds: 30 },
    requiresApproval: approval,
  },
});

const mutate = <T>(work: Parameters<ControlPlane['mutate']>[3]) =>
  control.mutate(p, randomUUID(), randomUUID(), work) as Promise<T>;

const post = (path: string, payload: object, token = f.operator.token, key = randomUUID()) =>
  app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload,
  });

const get = (path: string, token = f.operator.token) =>
  app.inject({
    method: 'GET',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}` },
  });

const review = async () => {
  const response = await post('/runbook-plans', {
    runbook_version_id: version.id,
    target_id: target.id,
  });

  expect(response.statusCode, response.body).toBe(200);

  return response.json();
};

const request = (id: string, token = f.operator.token, key = randomUUID()) =>
  post(`/runbook-plans/${id}/request`, { acknowledge_external_effects: true }, token, key);

const lease = (job: NonNullable<Awaited<ReturnType<ExecutionService['claim']>>>) => ({
  attempt_id: job.attempt_id,
  fence: job.fence,
  token: job.token,
});

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-runbooks-'));

  control = new ControlPlane(
    db,
    new LocalArtifactStore(root),
    new CredentialVault(randomBytes(32).toString('base64'), 'deployment-secrets'),
  );

  execution = new ExecutionService(control);
  app = await createApp(control);
});

beforeEach(async () => {
  f = await fixture(db);
  p = await control.authenticate(f.operator.token);

  project = await mutate((tx) =>
    control.project(tx, p, { name: 'Operations', slug: 'operations', description: '' }),
  );

  artifact = await mutate((tx) =>
    control.artifact(
      tx,
      p,
      { project_id: project.id, name: 'tasks', version: '1', digest: sha256(bytes) },
      bytes,
    ),
  );

  const fingerprint = randomBytes(32).toString('hex');

  await mutate((tx) =>
    execution.registerAgent(tx, p, { name: 'Private agent', certificate_fingerprint: fingerprint }),
  );

  agent = await execution.authenticate(fingerprint);

  target = await mutate((tx) =>
    execution.registerTarget(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: agent.id,
      name: 'Operations target',
      labels: {},
    }),
  );

  const created = await post('/runbooks', {
    project_id: project.id,
    environment_id: f.environments.staging,
    name: 'Maintenance',
    slug: 'maintenance',
  });

  expect(created.statusCode, created.body).toBe(200);
  book = created.json();

  const published = await post(`/runbooks/${book.id}/versions`, {
    artifact_id: artifact.id,
    process: process(),
    expected_revision: 0,
  });

  expect(published.statusCode, published.body).toBe(200);
  version = published.json();
});

afterAll(async () => {
  await app.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

it('validates bounded fixed tasks and rejects unreviewed inputs', () => {
  expect(
    parseRunbook({ ...process(), spec: { ...process().spec, requiresApproval: undefined } }).spec
      .requiresApproval,
  ).toBe(true);

  for (const task of [
    { command: [], timeoutSeconds: 1 },
    { command: ['task'], timeoutSeconds: 0 },
    { command: ['task'], timeoutSeconds: 121 },
    { command: ['bad\ncommand'], timeoutSeconds: 1 },
    { command: ['task'], timeoutSeconds: 1, network: 'host' },
    { command: ['task'], timeoutSeconds: 1, secrets: ['UNREVIEWED'] },
  ]) {
    expect(() => parseRunbook({ ...process(), spec: { ...process().spec, task } })).toThrow();
  }

  expect(() => parseRunbook({ ...process(), inputs: { command: 'anything' } })).toThrow();
});

it('keeps published versions and reviews immutable with optimistic publishing', async () => {
  expect(
    (
      await post(`/runbooks/${book.id}/versions`, {
        artifact_id: artifact.id,
        process: process(),
        expected_revision: 0,
      })
    ).statusCode,
  ).toBe(409);

  expect(
    (
      await post(`/runbooks/${book.id}/versions`, {
        artifact_id: artifact.id,
        process: process(),
        expected_revision: 1,
      })
    ).json().version,
  ).toBe(2);

  await expect(
    db.query('UPDATE runbook_versions SET manifest=$1 WHERE id=$2', [{}, version.id]),
  ).rejects.toThrow();

  const plan = await review();

  await expect(db.query('DELETE FROM runbook_plans WHERE id=$1', [plan.id])).rejects.toThrow();

  expect(plan).toMatchObject({
    version: 1,
    requires_approval: true,
    secret_bindings: [],
    manifest: { artifact: { digest: sha256(bytes) } },
  });
});

it('requires acknowledgement and a separate approver, deduplicating each reviewed request', async () => {
  const plan = await review();

  expect((await post(`/runbook-plans/${plan.id}/request`, {})).statusCode).toBe(400);
  const key = randomUUID();
  const first = await request(plan.id, f.operator.token, key);

  expect(first.statusCode, first.body).toBe(200);
  const run = first.json();

  expect(run).toMatchObject({ kind: 'runbook', release_id: null, status: 'awaiting_approval' });
  expect((await request(plan.id, f.operator.token, key)).json()).toEqual(run);
  expect((await request(plan.id)).statusCode).toBe(409);
  expect(await execution.tick(f.org, run.id)).toBe(false);
  expect((await post(`/deployments/${run.id}/approve`, {}, f.approver.token)).statusCode).toBe(404);

  await db.query(
    "UPDATE api_tokens SET permissions=ARRAY['read','write','approve'] WHERE actor_id=$1",
    [p.actor_id],
  );

  expect(
    (await post(`/runbook-runs/${run.id}/approve`, { acknowledge_external_effects: true }))
      .statusCode,
  ).toBe(403);

  expect((await post(`/runbook-runs/${run.id}/approve`, {}, f.approver.token)).statusCode).toBe(
    400,
  );

  const approved = await post(
    `/runbook-runs/${run.id}/approve`,
    { acknowledge_external_effects: true },
    f.approver.token,
  );

  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().status).toBe('queued');
});

it('serializes concurrent requests even when idempotency keys differ', async () => {
  const plan = await review();
  const results = await Promise.all([request(plan.id), request(plan.id)]);

  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
});

const inputDefinitions = {
  LABEL: { type: 'string', minLength: 0, maxLength: 80, default: '' },
  LIMIT: { type: 'integer', minimum: 0, maximum: 20, default: 0 },
  APPLY: { type: 'boolean', default: false },
  REGION: { type: 'enum', choices: ['east', 'west'], default: 'east' },
};

async function publishInputs() {
  const published = await post(`/runbooks/${book.id}/versions`, {
    artifact_id: artifact.id,
    expected_revision: 1,
    process: { ...process(), spec: { ...process().spec, inputs: inputDefinitions } },
  });

  expect(published.statusCode, published.body).toBe(200);
  version = published.json();
}

it('pins typed values and defaults through review, approval, history and agent dispatch', async () => {
  await publishInputs();
  const inputs = { LABEL: 'literal $(touch /tmp/not-created) = "check"', REGION: 'west' };
  const accepted = { APPLY: false, LABEL: inputs.LABEL, LIMIT: 0, REGION: 'west' };

  const reviewed = await post('/runbook-plans', {
    runbook_version_id: version.id,
    target_id: target.id,
    inputs,
  });

  expect(reviewed.statusCode, reviewed.body).toBe(200);
  const plan = reviewed.json();

  expect(plan.input_values).toEqual(accepted);
  expect(plan.manifest.process.spec.task.command).toEqual(['/bin/task']);

  await expect(
    db.query('UPDATE runbook_plans SET input_values=$1 WHERE id=$2', [{ LIMIT: 20 }, plan.id]),
  ).rejects.toThrow();

  expect(
    (
      await post(`/runbook-plans/${plan.id}/request`, {
        acknowledge_external_effects: true,
        inputs: { LIMIT: 20 },
      })
    ).statusCode,
  ).toBe(400);

  const run = (await request(plan.id)).json();

  expect((await get(`/resources/runbook-runs/${run.id}`)).json().input_values).toEqual(accepted);

  expect(
    (
      await post(
        `/runbook-runs/${run.id}/approve`,
        {
          acknowledge_external_effects: true,
          inputs: { LIMIT: 20 },
        },
        f.approver.token,
      )
    ).statusCode,
  ).toBe(400);

  expect(
    (
      await post(
        `/runbook-runs/${run.id}/approve`,
        {
          acknowledge_external_effects: true,
        },
        f.approver.token,
      )
    ).statusCode,
  ).toBe(200);

  const audit = (
    await db.query(
      "SELECT details FROM audit_events WHERE organisation_id=$1 AND action='runbook.queued' AND resource_id=$2",
      [f.org, run.id],
    )
  ).rows[0];

  expect(audit.details.input_values).toEqual(accepted);
  await execution.tick(f.org, run.id);
  expect(await execution.claim(agent, true, false, false, true, true)).toBeNull();
  const job = await execution.claim(agent, true, false, false, true, true, true);

  expect(job).toMatchObject({
    operation: 'runbook',
    runbook: { command: ['/bin/task'] },
    secret_count: 0,
    runbook_inputs: { APPLY: 'false', LABEL: inputs.LABEL, LIMIT: '0', REGION: 'west' },
  });

  await execution.complete(agent, {
    ...lease(job!),
    outcome: 'succeeded',
    code: 'RUNBOOK_SUCCEEDED',
  });

  expect((await get(`/resources/runbook-runs/${run.id}`)).json().input_values).toEqual(accepted);
});

it('rejects bad inputs before saving a review and binds idempotency to the supplied values', async () => {
  await publishInputs();

  for (const inputs of [
    { LIMIT: '3' },
    { LIMIT: 21 },
    { APPLY: 'true' },
    { REGION: 'north' },
    { EXTRA: true },
    { LABEL: 'line\nbreak' },
  ]) {
    const response = await post('/runbook-plans', {
      runbook_version_id: version.id,
      target_id: target.id,
      inputs,
    });

    expect(response.statusCode, response.body).toBe(400);
  }

  expect(
    (
      await db.query(
        'SELECT count(*)::integer AS count FROM runbook_plans WHERE organisation_id=$1',
        [f.org],
      )
    ).rows[0].count,
  ).toBe(0);

  const key = randomUUID();
  const input = { runbook_version_id: version.id, target_id: target.id, inputs: { LIMIT: 3 } };
  const first = await post('/runbook-plans', input, f.operator.token, key);

  expect(first.statusCode, first.body).toBe(200);
  expect((await post('/runbook-plans', input, f.operator.token, key)).json()).toEqual(first.json());

  expect(
    (await post('/runbook-plans', { ...input, inputs: { LIMIT: 4 } }, f.operator.token, key))
      .statusCode,
  ).toBe(409);
});

it('retains the reviewed defaults after a new version and omits inputs from recovery assignments', async () => {
  await publishInputs();
  const plan = await review();

  const published = await post(`/runbooks/${book.id}/versions`, {
    artifact_id: artifact.id,
    expected_revision: 2,
    process: {
      ...process(),
      spec: {
        ...process().spec,
        inputs: {
          ...inputDefinitions,
          LIMIT: { type: 'integer', minimum: 0, maximum: 20, default: 20 },
        },
      },
    },
  });

  expect(published.statusCode, published.body).toBe(200);
  const run = (await request(plan.id)).json();

  await post(
    `/runbook-runs/${run.id}/approve`,
    { acknowledge_external_effects: true },
    f.approver.token,
  );

  await execution.tick(f.org, run.id);
  const job = await execution.claim(agent, true, false, false, true, true, true);

  expect(job).toMatchObject({
    runbook_inputs: { LIMIT: '0', LABEL: '', APPLY: 'false', REGION: 'east' },
  });

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE deployment_id=$1",
    [run.id],
  );

  await execution.tick(f.org, run.id);
  expect(await execution.claim(agent, true, false, false, true, true)).toBeNull();
  const cleanup = await execution.claim(agent, true, false, false, true, true, true);

  expect(cleanup?.mode).toBe('cleanup');
  expect(cleanup).not.toHaveProperty('runbook_inputs');
  expect((await get(`/resources/runbook-runs/${run.id}`)).json().input_values.LIMIT).toBe(0);
});

it('rejects target and policy changes after review and target changes before assignment', async () => {
  const plan = await review();

  await db.query('UPDATE deployment_targets SET fence=fence+1 WHERE id=$1', [target.id]);
  expect((await request(plan.id)).json().error.code).toBe('STALE_RUNBOOK_REVIEW');
  const next = await review();

  await db.query('UPDATE environments SET policy_revision=policy_revision+1 WHERE id=$1', [
    f.environments.staging,
  ]);

  expect((await request(next.id)).json().error.code).toBe('STALE_RUNBOOK_REVIEW');
  const run = (await request((await review()).id)).json();

  await post(
    `/runbook-runs/${run.id}/approve`,
    { acknowledge_external_effects: true },
    f.approver.token,
  );

  await db.query('UPDATE deployment_targets SET fence=fence+1 WHERE id=$1', [target.id]);
  await execution.tick(f.org, run.id);

  expect((await get(`/resources/runbook-runs/${run.id}`)).json().result_code).toBe(
    'RUNBOOK_TARGET_CHANGED',
  );
});

it('does not turn task success into deployment or promotion evidence', async () => {
  const run = (await request((await review()).id)).json();

  await post(
    `/runbook-runs/${run.id}/approve`,
    { acknowledge_external_effects: true },
    f.approver.token,
  );

  await execution.tick(f.org, run.id);
  expect(await execution.claim(agent, true, true, true, true)).toBeNull();
  const job = (await execution.claim(agent, true, true, true, true, true))!;

  expect(job).toMatchObject({
    operation: 'runbook',
    strategy: 'task',
    health_path: '',
    hooks: null,
    runbook: { command: ['/bin/task'] },
  });

  expect(await execution.download(agent, lease(job))).toEqual(bytes);

  await expect(
    execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'HTTP_VERIFIED' }),
  ).rejects.toMatchObject({ code: 'INVALID_RESULT' });

  await expect(
    execution.progress(agent, { ...lease(job), phase: 'verifying_http' }),
  ).rejects.toMatchObject({ code: 'INVALID_PROGRESS' });

  await execution.progress(agent, { ...lease(job), phase: 'runbook_task' });

  await execution.complete(agent, {
    ...lease(job),
    outcome: 'succeeded',
    code: 'RUNBOOK_SUCCEEDED',
  });

  expect((await get(`/resources/runbook-runs/${run.id}`)).json().status).toBe('succeeded');
  expect((await get('/resources/deployments')).json().items).toEqual([]);

  expect(
    (
      await db.query(
        'SELECT current_state,current_release_id FROM deployment_targets WHERE id=$1',
        [target.id],
      )
    ).rows[0],
  ).toEqual({ current_state: 'unknown', current_release_id: null });

  expect(
    (await db.query('SELECT 1 FROM notification_deliveries WHERE deployment_id=$1', [run.id]))
      .rowCount,
  ).toBe(0);

  expect(
    (
      await db.query(
        "SELECT 1 FROM outbox WHERE payload->>'deployment_id'=$1 AND topic='runbook.succeeded'",
        [run.id],
      )
    ).rowCount,
  ).toBe(1);
});

it('keeps the environment locked through interruption and gates cleanup without secret delivery', async () => {
  const run = (await request((await review()).id)).json();

  await post(
    `/runbook-runs/${run.id}/approve`,
    { acknowledge_external_effects: true },
    f.approver.token,
  );

  await execution.tick(f.org, run.id);
  const job = (await execution.claim(agent, true, true, true, true, true))!;
  const blocked = await request((await review()).id);

  expect(blocked.statusCode).toBe(409);

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [job.attempt_id],
  );

  await execution.tick(f.org, run.id);
  expect(await execution.claim(agent, true, true, true, true)).toBeNull();
  const cleanup = (await execution.claim(agent, true, true, true, true, true))!;

  expect(cleanup).toMatchObject({ mode: 'cleanup', operation: 'runbook', secret_count: 0 });
  expect(cleanup.fence).toBeGreaterThan(job.fence);

  await expect(execution.download(agent, lease(cleanup))).rejects.toMatchObject({
    code: 'STALE_LEASE',
  });

  await expect(
    execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'RUNBOOK_SUCCEEDED' }),
  ).rejects.toMatchObject({ code: 'STALE_LEASE' });

  await execution.complete(agent, { ...lease(cleanup), outcome: 'failed', code: 'RECONCILED' });
  expect((await request((await review()).id)).statusCode).toBe(200);
});

it('enforces read, write, approve, organisation and environment boundaries before replay', async () => {
  const plan = await review();
  const other = await fixture(db);

  expect((await request(plan.id, f.reader.token)).statusCode).toBe(403);
  expect((await request(plan.id, other.operator.token)).statusCode).toBe(404);

  expect(
    (await get(`/resources/runbook-versions/${version.id}`, other.operator.token)).statusCode,
  ).toBe(404);

  const run = (await request(plan.id)).json();

  expect((await post(`/runbook-runs/${run.id}/cancel`, {}, f.reader.token)).statusCode).toBe(403);

  await db.query('UPDATE api_tokens SET environment_ids=$1 WHERE actor_id=$2', [
    [f.environments.production],
    f.operator.id,
  ]);

  expect((await get('/resources/runbooks')).json().items).toEqual([]);
  expect((await get(`/runbook-runs/${run.id}/secret-bindings`)).statusCode).toBe(404);
  expect((await post(`/runbook-runs/${run.id}/cancel`, {})).statusCode).toBe(404);

  expect(
    (await post('/runbook-plans', { runbook_version_id: version.id, target_id: target.id }))
      .statusCode,
  ).toBe(404);
});

it('pins secret versions, rejects rotation after review and refuses revoked delivery', async () => {
  const secret = await mutate<{ id: string }>((tx) =>
    control.secrets.create(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      name: 'PASSWORD',
      value: 'never-public',
    }),
  );

  const input = process(false);

  Object.assign(input.spec, { secrets: { TASK_PASSWORD: { secret: 'PASSWORD' } } });

  version = (
    await post(`/runbooks/${book.id}/versions`, {
      artifact_id: artifact.id,
      process: input,
      expected_revision: 1,
    })
  ).json();

  const stale = await review();

  await mutate((tx) =>
    control.secrets.rotate(tx, p, secret.id, { expected_revision: 1, value: 'also-private' }),
  );

  expect((await request(stale.id)).json().error.code).toBe('STALE_RUNBOOK_REVIEW');
  const plan = await review();

  expect(plan.secret_bindings).toEqual([
    { variable: 'TASK_PASSWORD', name: 'PASSWORD', version: 2 },
  ]);

  const run = (await request(plan.id)).json();

  expect(run.status).toBe('queued');
  await execution.tick(f.org, run.id);
  const job = (await execution.claim(agent, true, true, true, true, true))!;

  expect(job.secret_count).toBe(1);
  await mutate((tx) => control.secrets.revoke(tx, p, secret.id, 2));
  await expect(execution.secrets(agent, lease(job))).rejects.toThrow();
  const listed = await get('/resources/runbook-runs');

  expect(listed.body).not.toMatch(/never-public|also-private/);
});

it('rejects expired reviews and requires each requester to perform their own review', async () => {
  const plan = await review();

  await db.query(
    "UPDATE api_tokens SET permissions=ARRAY['read','write','approve'] WHERE actor_id=$1",
    [f.approver.id],
  );

  expect((await request(plan.id, f.approver.token)).json().error.code).toBe('REVIEW_REQUIRED');
  const expired = randomUUID();

  await db.query(
    `INSERT INTO runbook_plans (id,organisation_id,project_id,environment_id,runbook_version_id,target_id,expected_fence,policy_revision,requires_approval,secret_bindings,created_by,expires_at)
    SELECT $1,organisation_id,project_id,environment_id,runbook_version_id,target_id,expected_fence,policy_revision,requires_approval,secret_bindings,created_by,now()-interval '1 second' FROM runbook_plans WHERE id=$2`,
    [expired, plan.id],
  );

  expect((await request(expired)).json().error.code).toBe('STALE_RUNBOOK_REVIEW');
});

it('retains environment approval even when the task opts out', async () => {
  version = (
    await post(`/runbooks/${book.id}/versions`, {
      artifact_id: artifact.id,
      process: process(false),
      expected_revision: 1,
    })
  ).json();

  await db.query(
    'UPDATE environments SET requires_approval=true,policy_revision=policy_revision+1 WHERE id=$1',
    [f.environments.staging],
  );

  const plan = await review();

  expect(plan.requires_approval).toBe(true);
  expect((await request(plan.id)).json().status).toBe('awaiting_approval');
});

it('filters version and run history by immutable identifiers', async () => {
  const page = await get(`/resources/runbook-versions?runbook_id=${book.id}`);

  expect(page.statusCode, page.body).toBe(200);
  expect(page.json().items.map((row: { id: string }) => row.id)).toEqual([version.id]);

  expect((await get(`/resources/runbook-versions?runbook_id=${randomUUID()}`)).json().total).toBe(
    0,
  );

  const run = (await request((await review()).id)).json();

  expect(
    (
      await get(`/resources/runbook-runs?runbook_version_id=${version.id}&status=awaiting_approval`)
    ).json().items[0].id,
  ).toBe(run.id);

  expect(
    (await get(`/resources/runbook-runs?runbook_version_id=${randomUUID()}`)).json().total,
  ).toBe(0);
});

it('requires a new review after installation recovery, including pending runs', async () => {
  const pending = (await request((await review()).id)).json();
  const old = await review();

  await mutate(async (tx) => {
    await control.audit(tx, p, 'installation.restored', f.org, {});

    return {};
  });

  expect((await request(old.id)).json().error.code).toBe('STALE_RUNBOOK_REVIEW');

  await post(
    `/runbook-runs/${pending.id}/approve`,
    { acknowledge_external_effects: true },
    f.approver.token,
  );

  await execution.tick(f.org, pending.id);

  expect((await get(`/resources/runbook-runs/${pending.id}`)).json().result_code).toBe(
    'RUNBOOK_TARGET_CHANGED',
  );

  expect((await request((await review()).id)).statusCode).toBe(200);
});

it('shares the environment admission lock with ordinary deployments in both directions', async () => {
  const deployment = deploymentProcess();

  deployment.spec.artifact.name = 'tasks';

  const release = (
    await post('/releases', {
      project_id: project.id,
      artifact_id: artifact.id,
      version: '1',
      process: deployment,
    })
  ).json();

  const run = (await request((await review()).id)).json();

  expect(
    (await post('/deployments', { release_id: release.id, environment_id: f.environments.staging }))
      .statusCode,
  ).toBe(409);

  await post(`/runbook-runs/${run.id}/cancel`, {});

  expect(
    (await post('/deployments', { release_id: release.id, environment_id: f.environments.staging }))
      .statusCode,
  ).toBe(200);

  expect((await request((await review()).id)).statusCode).toBe(409);
});

it('refuses missing retained bytes at publication, review, request and approval', async () => {
  const plan = await review();

  await rm(join(root, f.org, sha256(bytes)));

  expect(
    (
      await post(`/runbooks/${book.id}/versions`, {
        artifact_id: artifact.id,
        process: process(),
        expected_revision: 1,
      })
    ).json().error.code,
  ).toBe('ARTIFACT_UNAVAILABLE');

  expect(
    (await post('/runbook-plans', { runbook_version_id: version.id, target_id: target.id })).json()
      .error.code,
  ).toBe('ARTIFACT_UNAVAILABLE');

  expect((await request(plan.id)).json().error.code).toBe('ARTIFACT_UNAVAILABLE');
  await control.store.put(f.org, sha256(bytes), bytes);
  const run = (await request(plan.id)).json();

  await rm(join(root, f.org, sha256(bytes)));

  expect(
    (
      await post(
        `/runbook-runs/${run.id}/approve`,
        { acknowledge_external_effects: true },
        f.approver.token,
      )
    ).json().error.code,
  ).toBe('ARTIFACT_UNAVAILABLE');

  expect((await get(`/resources/runbook-runs/${run.id}`)).json().status).toBe('awaiting_approval');
});

it('applies project restrictions before cached mutations can be replayed', async () => {
  const key = randomUUID();

  const payload = {
    project_id: project.id,
    environment_id: f.environments.staging,
    name: 'Cached task',
    slug: 'cached-task',
  };

  const created = await post('/runbooks', payload, f.operator.token, key);

  expect(created.statusCode).toBe(200);

  const unrelated = await mutate<{ id: string }>((tx) =>
    control.project(tx, p, { name: 'Other', slug: 'other', description: '' }),
  );

  await db.query('UPDATE api_tokens SET project_ids=$1 WHERE actor_id=$2', [
    [unrelated.id],
    f.operator.id,
  ]);

  expect((await post('/runbooks', payload, f.operator.token, key)).statusCode).toBe(403);
  expect((await get('/resources/runbooks')).json().items).toEqual([]);
  expect((await get(`/resources/runbook-versions/${version.id}`)).statusCode).toBe(404);

  expect(
    (
      await post(`/runbooks/${book.id}/versions`, {
        artifact_id: artifact.id,
        process: process(),
        expected_revision: 1,
      })
    ).statusCode,
  ).toBe(404);
});
