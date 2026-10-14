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
import { fixture, testDatabaseUrl } from '../fixtures.js';

const schema = `runbook_schedules_${randomUUID().replaceAll('-', '')}`;
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
const bytes = Buffer.from('retained scheduled image');

const process = (approval: boolean) => ({
  apiVersion: 'keel.dev/v1alpha1',
  kind: 'Runbook',
  spec: {
    artifact: { dockerImageId: `sha256:${'b'.repeat(64)}` },
    task: { command: ['/bin/nightly'], timeoutSeconds: 30 },
    inputs: { LABEL: { type: 'string', maxLength: 32, default: 'nightly' } },
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

const review = async (inputs: object = {}, token = f.operator.token) => {
  const response = await post(
    '/runbook-plans',
    { runbook_version_id: version.id, target_id: target.id, inputs },
    token,
  );

  expect(response.statusCode, response.body).toBe(200);

  return response.json();
};

const scheduleFrom = (planId: string, overrides: object = {}, token = f.operator.token) =>
  post(
    '/runbook-schedules',
    {
      runbook_plan_id: planId,
      name: 'Nightly maintenance',
      cron: '0 3 * * *',
      time_zone: 'UTC',
      acknowledge_external_effects: true,
      ...overrides,
    },
    token,
  );

const createSchedule = async (inputs: object = {}) => {
  const response = await scheduleFrom((await review(inputs)).id);

  expect(response.statusCode, response.body).toBe(200);

  return response.json();
};

const read = async (id: string) => (await get(`/resources/runbook-schedules/${id}`)).json();

const publish = async (approval: boolean) => {
  const current = (await get(`/resources/runbooks/${book.id}`)).json();

  const published = await post(`/runbooks/${book.id}/versions`, {
    artifact_id: artifact.id,
    process: process(approval),
    expected_revision: current.revision,
  });

  expect(published.statusCode, published.body).toBe(200);
  version = published.json();
};

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-runbook-schedules-'));

  control = new ControlPlane(
    db,
    new LocalArtifactStore(root),
    new CredentialVault(randomBytes(32).toString('base64'), 'deployment-secrets'),
  );

  execution = new ExecutionService(control);
  app = await createApp(control);
});

beforeEach(async () => {
  // The scheduler serves every workspace; earlier tests' schedules must not become due here.
  await db.query('UPDATE runbook_schedules SET enabled=false, next_run_at=NULL');
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
  await publish(false);
});

afterAll(async () => {
  await app.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

it('creates a schedule from a fresh review and runs each occurrence with the reviewed values', async () => {
  const plan = await review({ LABEL: 'cache sweep' });
  const before = Date.now();
  const response = await scheduleFrom(plan.id, { cron: '0   3 * * *' });

  expect(response.statusCode, response.body).toBe(200);
  const created = response.json();
  const due = new Date(created.next_run_at);

  expect(created).toMatchObject({
    cron: '0 3 * * *',
    time_zone: 'UTC',
    enabled: true,
    revision: 1,
    runbook_id: book.id,
    runbook_version_id: version.id,
  });

  expect(due.getTime()).toBeGreaterThan(before);
  expect(due.getUTCHours()).toBe(3);
  expect(due.getTime() - before).toBeLessThanOrEqual(86_400_000);

  // The review is consumed by the schedule and cannot also start a manual run or schedule.
  expect(
    (await post(`/runbook-plans/${plan.id}/request`, { acknowledge_external_effects: true })).json()
      .error.code,
  ).toBe('RUNBOOK_ALREADY_REQUESTED');

  expect((await scheduleFrom(plan.id)).json().error.code).toBe('RUNBOOK_ALREADY_REQUESTED');
  expect(await control.schedules.runDue(new Date(due.getTime() - 1000))).toBe(0);
  expect(await control.schedules.runDue(due)).toBe(1);
  expect(await control.schedules.runDue(due)).toBe(0);

  const runs = (await get(`/resources/runbook-runs?runbook_schedule_id=${created.id}`)).json();

  expect(runs.total).toBe(1);

  expect(runs.items[0]).toMatchObject({
    status: 'queued',
    requested_by: f.operator.id,
    runbook_schedule_id: created.id,
    scheduled_for: due.toISOString(),
    input_values: { LABEL: 'cache sweep' },
    target_id: target.id,
  });

  const listed = await read(created.id);

  expect(listed).toMatchObject({
    enabled: true,
    revision: 1,
    last_result_code: 'RUN_REQUESTED',
    last_run_id: runs.items[0].id,
    last_scheduled_for: due.toISOString(),
    next_run_at: new Date(due.getTime() + 86_400_000).toISOString(),
    runbook_name: 'Maintenance',
    target_name: 'Operations target',
    input_values: { LABEL: 'cache sweep' },
    created_by_name: 'operator',
  });

  const audit = (
    await db.query(
      "SELECT actor_id, details FROM audit_events WHERE organisation_id=$1 AND action='runbook.queued' AND resource_id=$2",
      [f.org, runs.items[0].id],
    )
  ).rows[0];

  expect(audit.actor_id).toBe(f.operator.id);

  expect(audit.details).toMatchObject({
    runbook_schedule_id: created.id,
    scheduled_for: due.toISOString(),
    input_values: { LABEL: 'cache sweep' },
  });

  await execution.tick(f.org, runs.items[0].id);
  const job = await execution.claim(agent, true, false, false, true, true, true);

  expect(job).toMatchObject({
    operation: 'runbook',
    runbook: { command: ['/bin/nightly'] },
    runbook_inputs: { LABEL: 'cache sweep' },
  });
});

it('skips busy and missed occurrences without releasing a burst of overdue runs', async () => {
  const created = await createSchedule();
  const due = new Date(created.next_run_at);

  const manual = await post(`/runbook-plans/${(await review()).id}/request`, {
    acknowledge_external_effects: true,
  });

  expect(manual.statusCode, manual.body).toBe(200);
  expect(await control.schedules.runDue(due)).toBe(1);

  expect(await read(created.id)).toMatchObject({
    enabled: true,
    last_result_code: 'ENVIRONMENT_BUSY',
    last_scheduled_for: due.toISOString(),
    next_run_at: new Date(due.getTime() + 86_400_000).toISOString(),
  });

  await post(`/runbook-runs/${manual.json().id}/cancel`, {});

  // Three days late: one skipped occurrence, then the next future time.
  const late = new Date(due.getTime() + 3 * 86_400_000 + 60_000);

  expect(await control.schedules.runDue(late)).toBe(1);
  expect(await control.schedules.runDue(late)).toBe(0);

  expect(await read(created.id)).toMatchObject({
    enabled: true,
    last_result_code: 'SCHEDULE_MISSED',
    next_run_at: new Date(due.getTime() + 4 * 86_400_000).toISOString(),
  });

  expect(
    (await get(`/resources/runbook-runs?runbook_schedule_id=${created.id}`)).json().total,
  ).toBe(0);

  const skipped = await db.query(
    "SELECT details->>'code' AS code FROM audit_events WHERE organisation_id=$1 AND action='runbook.schedule_skipped' AND resource_id=$2 ORDER BY created_at",
    [f.org, created.id],
  );

  expect(skipped.rows.map((row) => row.code)).toEqual(['ENVIRONMENT_BUSY', 'SCHEDULE_MISSED']);
});

it('keeps approval and separation of duties for every scheduled run', async () => {
  await publish(true);
  const created = await createSchedule();

  await control.schedules.runDue(new Date(created.next_run_at));

  const run = (await get(`/resources/runbook-runs?runbook_schedule_id=${created.id}`)).json()
    .items[0];

  expect(run.status).toBe('awaiting_approval');

  await db.query(
    "UPDATE api_tokens SET permissions=ARRAY['read','write','approve'] WHERE actor_id=$1",
    [f.operator.id],
  );

  expect(
    (await post(`/runbook-runs/${run.id}/approve`, { acknowledge_external_effects: true })).json()
      .error.code,
  ).toBe('SELF_APPROVAL');

  expect(
    (
      await post(
        `/runbook-runs/${run.id}/approve`,
        { acknowledge_external_effects: true },
        f.approver.token,
      )
    ).json().status,
  ).toBe('queued');
});

it('pauses after policy, access or recovery changes and lets only the creator resume', async () => {
  const policy = await createSchedule();

  await db.query('UPDATE environments SET policy_revision=policy_revision+1 WHERE id=$1', [
    f.environments.staging,
  ]);

  await control.schedules.runDue(new Date(policy.next_run_at));

  expect(await read(policy.id)).toMatchObject({
    enabled: false,
    next_run_at: null,
    revision: 2,
    paused_code: 'STALE_RUNBOOK_SCHEDULE',
    last_result_code: 'STALE_RUNBOOK_SCHEDULE',
  });

  expect(
    (
      await post(`/runbook-schedules/${policy.id}/state`, {
        enabled: true,
        expected_revision: 2,
      })
    ).json().error.code,
  ).toBe('STALE_RUNBOOK_SCHEDULE');

  const access = await createSchedule();

  await db.query("UPDATE api_tokens SET permissions=ARRAY['read'] WHERE actor_id=$1", [
    f.operator.id,
  ]);

  await control.schedules.runDue(new Date(access.next_run_at));

  await db.query("UPDATE api_tokens SET permissions=ARRAY['read','write'] WHERE actor_id=$1", [
    f.operator.id,
  ]);

  expect(await read(access.id)).toMatchObject({
    enabled: false,
    paused_code: 'SCHEDULE_OWNER_ACCESS_CHANGED',
  });

  await db.query(
    "UPDATE api_tokens SET permissions=ARRAY['read','write','approve'] WHERE actor_id=$1",
    [f.approver.id],
  );

  expect(
    (
      await post(
        `/runbook-schedules/${access.id}/state`,
        { enabled: true, expected_revision: 2 },
        f.approver.token,
      )
    ).json().error.code,
  ).toBe('SCHEDULE_OWNER_REQUIRED');

  expect(
    (await post(`/runbook-schedules/${access.id}/state`, { enabled: true, expected_revision: 1 }))
      .statusCode,
  ).toBe(409);

  const resumed = await post(`/runbook-schedules/${access.id}/state`, {
    enabled: true,
    expected_revision: 2,
  });

  expect(resumed.statusCode, resumed.body).toBe(200);

  expect(resumed.json()).toMatchObject({ enabled: true, revision: 3, paused_code: null });
  expect(new Date(resumed.json().next_run_at).getTime()).toBeGreaterThan(Date.now());

  // Any writer can stop a schedule.
  const stopped = await post(
    `/runbook-schedules/${access.id}/state`,
    { enabled: false, expected_revision: 3 },
    f.approver.token,
  );

  expect(stopped.json()).toMatchObject({ enabled: false, next_run_at: null, revision: 4 });

  const recovered = await createSchedule();

  await mutate(async (tx) => {
    await control.audit(tx, p, 'installation.restored', f.org, {});

    return {};
  });

  await control.schedules.runDue(new Date(recovered.next_run_at));

  expect(await read(recovered.id)).toMatchObject({
    enabled: false,
    paused_code: 'INSTALLATION_RESTORED',
  });

  expect(
    (
      await post(`/runbook-schedules/${recovered.id}/state`, {
        enabled: true,
        expected_revision: 2,
      })
    ).json().error.code,
  ).toBe('STALE_RUNBOOK_SCHEDULE');
});

it('pauses when a bound secret rotates after review', async () => {
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

  const created = await createSchedule();

  await mutate((tx) =>
    control.secrets.rotate(tx, p, secret.id, { expected_revision: 1, value: 'also-private' }),
  );

  await control.schedules.runDue(new Date(created.next_run_at));

  expect(await read(created.id)).toMatchObject({
    enabled: false,
    paused_code: 'STALE_RUNBOOK_SCHEDULE',
  });

  expect((await get('/resources/runbook-schedules')).body).not.toMatch(/never-public|also-private/);
});

it('validates schedule definitions and keeps them immutable', async () => {
  const plan = await review();

  for (const [overrides, code] of [
    [{ cron: '* * * * *' }, 'INVALID_SCHEDULE'],
    [{ cron: '0,3 * * * *' }, 'INVALID_SCHEDULE'],
    [{ cron: '0 0 31 2 *' }, 'INVALID_SCHEDULE'],
    [{ cron: '0 24 * * *' }, 'INVALID_SCHEDULE'],
    [{ time_zone: 'Mars/Olympus' }, 'INVALID_SCHEDULE'],
    [{ time_zone: '../UTC' }, 'INVALID_SCHEDULE'],
  ] as const) {
    expect((await scheduleFrom(plan.id, overrides)).json().error.code).toBe(code);
  }

  expect((await scheduleFrom(plan.id, { acknowledge_external_effects: false })).statusCode).toBe(
    400,
  );

  const zoned = await scheduleFrom(plan.id, {
    cron: '30 9 * * 1-5',
    time_zone: 'Australia/Brisbane',
  });

  expect(zoned.statusCode, zoned.body).toBe(200);
  const next = new Date(zoned.json().next_run_at);

  expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([23, 30]);
  expect([0, 1, 2, 3, 4]).toContain(next.getUTCDay());

  await expect(
    db.query("UPDATE runbook_schedules SET cron='0 4 * * *' WHERE id=$1", [zoned.json().id]),
  ).rejects.toThrow();

  await expect(
    db.query('DELETE FROM runbook_schedules WHERE id=$1', [zoned.json().id]),
  ).rejects.toThrow();
});

it('enforces authorship, permissions, organisation and environment scopes', async () => {
  const plan = await review();
  const other = await fixture(db);

  await db.query(
    "UPDATE api_tokens SET permissions=ARRAY['read','write','approve'] WHERE actor_id=$1",
    [f.approver.id],
  );

  expect((await scheduleFrom(plan.id, {}, f.approver.token)).json().error.code).toBe(
    'REVIEW_REQUIRED',
  );

  expect((await scheduleFrom(plan.id, {}, f.reader.token)).statusCode).toBe(403);
  expect((await scheduleFrom(plan.id, {}, other.operator.token)).statusCode).toBe(404);

  const created = (await scheduleFrom(plan.id)).json();

  expect((await get(`/resources/runbook-schedules/${created.id}`, f.reader.token)).statusCode).toBe(
    200,
  );

  expect(
    (await get(`/resources/runbook-schedules/${created.id}`, other.operator.token)).statusCode,
  ).toBe(404);

  expect(
    (
      await post(
        `/runbook-schedules/${created.id}/state`,
        { enabled: false, expected_revision: 1 },
        f.reader.token,
      )
    ).statusCode,
  ).toBe(403);

  await db.query('UPDATE api_tokens SET environment_ids=$1 WHERE actor_id=$2', [
    [f.environments.production],
    f.operator.id,
  ]);

  expect((await get('/resources/runbook-schedules')).json().items).toEqual([]);

  expect(
    (
      await post(`/runbook-schedules/${created.id}/state`, {
        enabled: false,
        expected_revision: 1,
      })
    ).statusCode,
  ).toBe(404);

  // A token narrowed away from the schedule's environment no longer authorizes its runs.
  await control.schedules.runDue(new Date(created.next_run_at));

  expect(
    (await db.query('SELECT paused_code FROM runbook_schedules WHERE id=$1', [created.id])).rows[0]
      .paused_code,
  ).toBe('SCHEDULE_OWNER_ACCESS_CHANGED');
});
