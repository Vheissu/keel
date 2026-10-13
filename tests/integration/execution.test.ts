import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../packages/database/src/migrate.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { createApp } from '../../apps/api/src/app.js';
import { ExecutionService, type AgentIdentity } from '../../apps/api/src/execution-service.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';

const schema = `execution_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let root: string;
let control: ControlPlane;
let execution: ExecutionService;
let f: Awaited<ReturnType<typeof fixture>>;
let p: Awaited<ReturnType<ControlPlane['authenticate']>>;
let agent: AgentIdentity;
let project: { id: string };
let target: { id: string };
let release: { id: string };
const bytes = Buffer.from('docker save fixture');
const imageID = `sha256:${'a'.repeat(64)}`;

const mutate = <T>(work: Parameters<ControlPlane['mutate']>[3]) =>
  control.mutate(p, randomUUID(), randomUUID(), work) as Promise<T>;

async function requestDeployment(environment = f.environments.staging) {
  return mutate<{ id: string; status: string }>((tx) =>
    control.deploy(tx, p, { release_id: release.id, environment_id: environment }),
  );
}

async function status(id: string) {
  return (await db.query('SELECT status FROM deployments WHERE id=$1', [id])).rows[0].status;
}

async function assigned() {
  const d = await requestDeployment();

  await execution.tick(f.org, d.id);
  const job = await execution.claim(agent);

  expect(job).not.toBeNull();

  return { d, job: job! };
}

function lease(job: NonNullable<Awaited<ReturnType<ExecutionService['claim']>>>) {
  return { attempt_id: job.attempt_id, fence: job.fence, token: job.token };
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-execution-'));
  control = new ControlPlane(db, new LocalArtifactStore(root));
  execution = new ExecutionService(control);
});

beforeEach(async () => {
  f = await fixture(db);
  p = await control.authenticate(f.operator.token);

  project = await mutate((tx) =>
    control.project(tx, p, { name: 'Docker application', slug: 'web', description: '' }),
  );

  const artifact = await mutate<{ id: string }>((tx) =>
    control.artifact(
      tx,
      p,
      { project_id: project.id, name: 'application', version: '1', digest: sha256(bytes) },
      bytes,
    ),
  );

  const process = deploymentProcess();

  Object.assign(process.spec.artifact, { dockerImageId: imageID });

  for (const env of Object.values(process.spec.environments)) {
    Object.assign(env, { strategy: 'recreate', verify: { http: { path: '/' } } });
  }

  release = await mutate((tx) =>
    control.release(tx, p, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: '1',
      process,
    }),
  );

  const fingerprint = randomBytes(32).toString('hex');

  await mutate((tx) =>
    execution.registerAgent(tx, p, { name: 'Private host', certificate_fingerprint: fingerprint }),
  );

  agent = await execution.authenticate(fingerprint);

  target = await mutate((tx) =>
    execution.registerTarget(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: agent.id,
      name: 'Web staging',
      labels: { tier: 'staging' },
    }),
  );
});

afterAll(async () => {
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

describe('Fenced deployment execution', () => {
  it('schedules once, verifies retained bytes and projects only a successful target release', async () => {
    const { d, job } = await assigned();

    await execution.tick(f.org, d.id);
    expect(await execution.claim(agent)).toBeNull();
    expect(job.image_id).toBe(imageID);
    expect(await execution.download(agent, lease(job))).toEqual(bytes);
    expect(await execution.heartbeat(agent, lease(job))).toEqual({ action: 'continue' });
    expect(await status(d.id)).toBe('running');

    expect(
      (await db.query('SELECT current_state FROM deployment_targets WHERE id=$1', [target.id]))
        .rows[0].current_state,
    ).toBe('unknown');

    await execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'HTTP_VERIFIED' });
    expect(await execution.tick(f.org, d.id)).toBe(true);
    expect(await status(d.id)).toBe('succeeded');

    expect(
      (
        await db.query(
          'SELECT current_release_id,current_state FROM deployment_targets WHERE id=$1',
          [target.id],
        )
      ).rows[0],
    ).toEqual({ current_release_id: release.id, current_state: 'verified' });

    await expect(
      execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'HTTP_VERIFIED' }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM deployment_events WHERE deployment_id=$1 AND status='succeeded'",
            [d.id],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  });

  it('replaces a revoked certificate without unlocking interrupted work or accepting stale authentication', async () => {
    const { d, job } = await assigned();
    const replacement = randomBytes(32).toString('hex');
    const input = { certificate_fingerprint: replacement, same_host_agent_stopped: true as const };

    await expect(
      mutate((tx) => execution.replaceCertificate(tx, p, agent.id, input)),
    ).rejects.toMatchObject({ code: 'AGENT_BUSY' });

    await mutate((tx) => execution.agentState(tx, p, agent.id, 'revoked'));

    await expect(
      mutate((tx) => execution.replaceCertificate(tx, p, agent.id, input)),
    ).rejects.toMatchObject({ code: 'AGENT_BUSY' });

    await db.query(
      `
        UPDATE deployment_attempts
        SET
          lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE
          id = $1
      `,
      [job.attempt_id],
    );

    await execution.tick(f.org, d.id);
    await mutate((tx) => execution.replaceCertificate(tx, p, agent.id, input));

    await expect(execution.authenticate(agent.certificate_fingerprint)).rejects.toMatchObject({
      code: 'AGENT_UNAUTHENTICATED',
    });

    await expect(execution.claim(agent)).rejects.toMatchObject({ code: 'AGENT_UNAUTHENTICATED' });

    await expect(
      execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'HTTP_VERIFIED' }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAUTHENTICATED' });

    await expect(requestDeployment()).rejects.toMatchObject({ code: '23505' });

    await expect(
      mutate((tx) => execution.agentState(tx, p, agent.id, 'active')),
    ).rejects.toMatchObject({ code: 'RECOVERY_PENDING' });

    await expect(
      mutate((tx) =>
        execution.registerAgent(tx, p, {
          name: 'Retired',
          certificate_fingerprint: agent.certificate_fingerprint,
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const recovered = await execution.authenticate(replacement);

    expect(recovered.id).toBe(agent.id);
    expect(recovered.state).toBe('draining');
    const cleanup = (await execution.claim(recovered))!;

    expect(cleanup.mode).toBe('cleanup');
    expect(cleanup.fence).toBeGreaterThan(job.fence);

    await execution.complete(recovered, {
      ...lease(cleanup),
      outcome: 'failed',
      code: 'RECONCILED',
    });

    await mutate((tx) => execution.agentState(tx, p, agent.id, 'active'));
    expect((await requestDeployment()).status).toBe('queued');

    expect(
      (
        await db.query(
          `
            SELECT
              details
            FROM
              audit_events
            WHERE
              action = 'agent.certificate_replaced'
              AND resource_id = $1
          `,
          [agent.id],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('authorizes and deduplicates certificate replacement through the API', async () => {
    await mutate((tx) => execution.agentState(tx, p, agent.id, 'draining'));
    const app = await createApp(control);

    const input = {
      certificate_fingerprint: randomBytes(32).toString('hex'),
      same_host_agent_stopped: true,
    };

    const key = randomUUID();

    const post = (token: string, payload: object = input) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/certificate`,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
        payload,
      });

    try {
      expect((await post(f.reader.token)).statusCode).toBe(403);
      const other = await fixture(db);

      expect((await post(other.operator.token)).statusCode).toBe(404);

      expect(
        (await post(f.operator.token, { ...input, same_host_agent_stopped: false })).statusCode,
      ).toBe(400);

      const first = await post(f.operator.token);

      expect(first.statusCode).toBe(200);
      expect((await post(f.operator.token)).json()).toEqual(first.json());

      expect(
        (
          await db.query(
            `
        SELECT
          id
        FROM
          audit_events
        WHERE
          action = 'agent.certificate_replaced'
          AND resource_id = $1
      `,
            [agent.id],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('records only scoped progress and rejects stale and recovery-incompatible updates', async () => {
    const { d, job } = await assigned();

    await execution.progress(agent, { ...lease(job), phase: 'verifying_http' });

    expect(
      (await db.query('SELECT phase FROM deployment_attempts WHERE id=$1', [job.attempt_id]))
        .rows[0].phase,
    ).toBe('verifying_http');

    await expect(
      execution.progress(agent, { ...lease(job), token: 'b'.repeat(64), phase: 'loading_image' }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    await mutate((tx) => control.transition(tx, p, d.id, 'cancel'));

    await expect(
      execution.progress(agent, { ...lease(job), phase: 'loading_image' }),
    ).rejects.toMatchObject({ code: 'INVALID_PROGRESS' });

    await execution.progress(agent, { ...lease(job), phase: 'cleaning_up' });
  });

  it('keeps production unassigned until a different actor approves', async () => {
    const d = await requestDeployment(f.environments.production);

    expect(await execution.tick(f.org, d.id)).toBe(false);
    expect(await execution.claim(agent)).toBeNull();

    await expect(mutate((tx) => control.transition(tx, p, d.id, 'approve'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const approver = await control.authenticate(f.approver.token);

    await control.mutate(approver, randomUUID(), randomUUID(), (tx) =>
      control.transition(tx, approver, d.id, 'approve'),
    );

    expect(await status(d.id)).toBe('queued');
  });

  it('retains locks during cancellation, rejects success, then accepts cleanup', async () => {
    const { d, job } = await assigned();

    await mutate((tx) => control.transition(tx, p, d.id, 'cancel'));
    expect(await status(d.id)).toBe('cancel_requested');
    expect(await execution.heartbeat(agent, lease(job))).toEqual({ action: 'cleanup' });
    await expect(requestDeployment()).rejects.toMatchObject({ code: '23505' });

    await expect(
      execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'HTTP_VERIFIED' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT' });

    await expect(execution.download(agent, lease(job))).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });

    await execution.complete(agent, { ...lease(job), outcome: 'cancelled', code: 'CANCELLED' });
    expect(await status(d.id)).toBe('cancelled');
    expect((await requestDeployment()).status).toBe('queued');
  });

  it('reconciles expiry with a new fence, rejecting all old credentials', async () => {
    const { d, job } = await assigned();

    await db.query(
      `
        UPDATE deployment_attempts
        SET
          lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE
          id = $1
      `,
      [job.attempt_id],
    );

    await expect(
      execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'HTTP_VERIFIED' }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    await execution.tick(f.org, d.id);
    expect(await status(d.id)).toBe('reconciliation_required');
    await expect(requestDeployment()).rejects.toMatchObject({ code: '23505' });
    const cleanup = (await execution.claim(agent))!;

    expect(cleanup.mode).toBe('cleanup');
    expect(cleanup.fence).toBeGreaterThan(job.fence);

    await expect(execution.heartbeat(agent, lease(job))).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });

    await expect(execution.download(agent, lease(cleanup))).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });

    await expect(
      execution.complete(agent, { ...lease(cleanup), outcome: 'succeeded', code: 'HTTP_VERIFIED' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT' });

    await execution.complete(agent, { ...lease(cleanup), outcome: 'failed', code: 'RECONCILED' });
    expect(await status(d.id)).toBe('failed');
    const next = await assigned();

    expect(next.job.fence).toBeGreaterThan(cleanup.fence);
  });

  it('does not dispatch a cancelled ready attempt', async () => {
    const d = await requestDeployment();

    await execution.tick(f.org, d.id);
    await mutate((tx) => control.transition(tx, p, d.id, 'cancel'));
    expect(await execution.claim(agent)).toBeNull();
    expect(await execution.tick(f.org, d.id)).toBe(true);

    expect(
      (await db.query('SELECT state FROM deployment_attempts WHERE deployment_id=$1', [d.id]))
        .rows[0].state,
    ).toBe('cancelled');
  });

  it('fails an offline assigned agent without running anything', async () => {
    const d = await requestDeployment();

    await execution.tick(f.org, d.id);

    await db.query(
      `
        UPDATE deployment_attempts
        SET
          created_at = now() - interval '6 minutes'
        WHERE
          deployment_id = $1
      `,
      [d.id],
    );

    expect(await execution.tick(f.org, d.id)).toBe(true);
    expect(await status(d.id)).toBe('failed');
    expect(await execution.claim(agent)).toBeNull();
  });

  it('drains without disrupting active work and revokes existing lease access', async () => {
    const { d, job } = await assigned();

    await mutate((tx) => execution.agentState(tx, p, agent.id, 'draining'));
    expect(await execution.heartbeat(agent, lease(job))).toEqual({ action: 'continue' });
    await mutate((tx) => execution.agentState(tx, p, agent.id, 'revoked'));

    await expect(execution.heartbeat(agent, lease(job))).rejects.toMatchObject({
      code: 'AGENT_UNAUTHENTICATED',
    });

    await expect(
      execution.complete(agent, { ...lease(job), outcome: 'succeeded', code: 'HTTP_VERIFIED' }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAUTHENTICATED' });

    expect(await status(d.id)).toBe('running');
  });

  it('isolates organisations, agents and artifact credentials', async () => {
    const { job } = await assigned();
    const other = await fixture(db);
    const principal = await control.authenticate(other.operator.token);

    await expect(
      control.mutate(principal, randomUUID(), randomUUID(), (tx) =>
        execution.registerTarget(tx, principal, {
          name: 'Foreign',
          project_id: project.id,
          environment_id: other.environments.staging,
          agent_id: agent.id,
          labels: { tier: 'staging' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const fingerprint = randomBytes(32).toString('hex');

    await mutate((tx) =>
      execution.registerAgent(tx, p, { name: 'Other agent', certificate_fingerprint: fingerprint }),
    );

    const wrongAgent = await execution.authenticate(fingerprint);

    await expect(execution.download(wrongAgent, lease(job))).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });

    await expect(
      execution.download(agent, { ...lease(job), token: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    const app = await createApp(control);

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v1/execution',
      headers: { authorization: `Bearer ${other.operator.token}` },
    });

    expect(snapshot.json()).toEqual({ agents: [], targets: [], attempts: [] });

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${f.reader.token}`, 'idempotency-key': randomUUID() },
      payload: { name: 'No', certificate_fingerprint: randomBytes(32).toString('hex') },
    });

    expect(denied.statusCode).toBe(403);

    const own = await app.inject({
      method: 'GET',
      url: '/api/v1/execution',
      headers: { authorization: `Bearer ${f.operator.token}` },
    });

    expect(own.body).not.toContain(job.token);
    expect(own.body).not.toContain('lease_hash');
    await app.close();
  });

  it('rejects ambiguous matching targets without touching either', async () => {
    await mutate((tx) =>
      execution.registerTarget(tx, p, {
        project_id: project.id,
        environment_id: f.environments.staging,
        agent_id: agent.id,
        name: 'Duplicate selector',
        labels: { tier: 'staging' },
      }),
    );

    const d = await requestDeployment();

    expect(await execution.tick(f.org, d.id)).toBe(true);
    expect(await status(d.id)).toBe('failed');
    expect(await execution.claim(agent)).toBeNull();
  });

  it('does not accept unsupported execution declarations as success', async () => {
    const artifact = (await db.query('SELECT artifact_id FROM releases WHERE id=$1', [release.id]))
      .rows[0];

    release = await mutate((tx) =>
      control.release(tx, p, {
        project_id: project.id,
        artifact_id: artifact.artifact_id,
        version: 'unsupported',
        process: deploymentProcess(),
      }),
    );

    const d = await requestDeployment();

    expect(await execution.tick(f.org, d.id)).toBe(true);

    expect(
      (await db.query('SELECT result_code FROM deployments WHERE id=$1', [d.id])).rows[0]
        .result_code,
    ).toBe('UNSUPPORTED_PROCESS');
  });
});

it('gates SSH deployment and reconciliation claims on the SSH capability', async () => {
  await db.query('DELETE FROM deployment_targets WHERE id=$1', [target.id]);

  target = await mutate((tx) =>
    execution.registerTarget(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: agent.id,
      name: 'SSH target',
      labels: { tier: 'staging' },
      capability: 'ssh-docker-recreate-v1',
    }),
  );

  const d = await requestDeployment();

  await execution.tick(f.org, d.id);
  expect(await execution.claim(agent, true)).toBeNull();
  const job = await execution.claim(agent, true, true);

  expect(job).toMatchObject({ capability: 'ssh-docker-recreate-v1', mode: 'deploy' });

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE deployment_id=$1",
    [d.id],
  );

  await execution.tick(f.org, d.id);
  expect(await execution.claim(agent, true)).toBeNull();
  const cleanup = await execution.claim(agent, true, true);

  expect(cleanup).toMatchObject({ capability: 'ssh-docker-recreate-v1', mode: 'cleanup' });
  expect(cleanup!.fence).toBeGreaterThan(job!.fence);
});

it('rejects incompatible target strategies before assignment', async () => {
  await db.query("UPDATE deployment_targets SET capability='docker-blue-green-v1' WHERE id=$1", [
    target.id,
  ]);

  const d = await requestDeployment();

  await execution.tick(f.org, d.id);

  expect(
    (await db.query('SELECT status,result_code FROM deployments WHERE id=$1', [d.id])).rows[0],
  ).toEqual({ status: 'failed', result_code: 'INCOMPATIBLE_TARGET_STRATEGY' });

  expect(await execution.claim(agent, true, true, true)).toBeNull();
});

async function blueGreenRelease() {
  const original = (await db.query('SELECT * FROM releases WHERE id=$1', [release.id])).rows[0];
  const process = original.manifest.process;

  process.spec.environments.staging.strategy = 'blue-green';

  const artifact = (await db.query('SELECT id FROM artifacts WHERE project_id=$1', [project.id]))
    .rows[0];

  release = await mutate((tx) =>
    control.release(tx, p, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: 'blue-green',
      process,
    }),
  );
}

it('gates blue/green claims and recovery on explicit agent support', async () => {
  await blueGreenRelease();

  await db.query("UPDATE deployment_targets SET capability='docker-blue-green-v1' WHERE id=$1", [
    target.id,
  ]);

  const d = await requestDeployment();

  await execution.tick(f.org, d.id);
  expect(await execution.claim(agent, true, true)).toBeNull();
  const job = (await execution.claim(agent, true, false, true))!;

  expect(job).toMatchObject({ strategy: 'blue-green', capability: 'docker-blue-green-v1' });

  await expect(
    execution.complete(agent, { ...lease(job), outcome: 'failed', code: 'HEALTH_FAILED' }),
  ).rejects.toMatchObject({ code: 'INVALID_RESULT' });

  await execution.progress(agent, { ...lease(job), phase: 'starting_candidate' });
  await execution.progress(agent, { ...lease(job), phase: 'switching_traffic' });

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [job.attempt_id],
  );

  await execution.tick(f.org, d.id);
  expect(await execution.claim(agent, true, true)).toBeNull();
  const cleanup = (await execution.claim(agent, true, false, true))!;

  expect(cleanup.mode).toBe('cleanup');
  expect(cleanup.fence).toBeGreaterThan(job.fence);

  await expect(
    execution.complete(agent, {
      ...lease(job),
      outcome: 'failed',
      code: 'RECONCILED',
      recovery: 'previous_route_restored',
    }),
  ).rejects.toMatchObject({ code: 'STALE_LEASE' });

  await execution.complete(agent, {
    ...lease(cleanup),
    outcome: 'failed',
    code: 'RECONCILED',
    recovery: 'previous_route_restored',
  });

  expect(
    (await db.query('SELECT state,recovery FROM deployment_attempts WHERE id=$1', [job.attempt_id]))
      .rows[0],
  ).toEqual({ state: 'failed', recovery: 'previous_route_restored' });

  expect(
    (await db.query('SELECT current_state FROM deployment_targets WHERE id=$1', [target.id]))
      .rows[0].current_state,
  ).toBe('unknown');
});

it('rejects blue/green on SSH and rejects recovery claims from recreate agents', async () => {
  const { job } = await assigned();

  await expect(
    execution.complete(agent, {
      ...lease(job),
      outcome: 'failed',
      code: 'HEALTH_FAILED',
      recovery: 'previous_route_restored',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_RESULT' });

  await execution.complete(agent, { ...lease(job), outcome: 'failed', code: 'HEALTH_FAILED' });
  await blueGreenRelease();

  await db.query("UPDATE deployment_targets SET capability='ssh-docker-recreate-v1' WHERE id=$1", [
    target.id,
  ]);

  const d = await requestDeployment();

  await execution.tick(f.org, d.id);

  expect(
    (await db.query('SELECT result_code FROM deployments WHERE id=$1', [d.id])).rows[0].result_code,
  ).toBe('INCOMPATIBLE_TARGET_STRATEGY');
});
