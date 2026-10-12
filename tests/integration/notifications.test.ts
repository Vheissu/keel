import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../../packages/database/src/migrate.js';
import { transaction } from '../../packages/database/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { enqueueNotifications } from '../../apps/api/src/notifications.js';
import {
  NotificationWorker,
  type NotificationTransport,
} from '../../apps/api/src/notification-worker.js';
import { quarantine } from '../../apps/operations/src/recovery.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';

const schema = `notifications_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const key = randomBytes(32).toString('base64');
const vault = new CredentialVault(key, 'notifications');
const secret = 'receiver-secret-with-at-least-thirty-two-characters';
const url = 'https://receiver.example/hooks/private-token?key=private-query';
let app: FastifyInstance;
let root: string;
let control: ControlPlane;
let f: Awaited<ReturnType<typeof fixture>>;

beforeAll(async () => {
  vi.stubEnv('KEEL_CREDENTIAL_KEY', key);
  vi.stubEnv('KEEL_NOTIFICATION_ORIGINS', 'https://receiver.example');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-notifications-'));
  control = new ControlPlane(db, new LocalArtifactStore(root));
  app = await createApp(control);
});

beforeEach(async () => {
  await db.query('TRUNCATE notification_attempts, notification_deliveries, notification_endpoints');
  f = await fixture(db);
});

afterAll(async () => {
  await app.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function post(
  path: string,
  payload: unknown,
  token = f.operator.token,
  idempotency = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    payload: payload as object,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotency },
  });
}

function get(path: string, token = f.reader.token) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/resources/${path}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function endpoint(extra: Record<string, unknown> = {}) {
  const result = await post('/notifications/endpoints', {
    name: 'Operations',
    url,
    signing_secret: secret,
    statuses: ['queued', 'cancelled', 'failed'],
    ...extra,
  });

  expect(result.statusCode).toBe(200);

  return result.json();
}

async function deployment() {
  const principal = await control.authenticate(f.operator.token);

  return transaction(db, async (tx) => {
    const project = await control.project(tx, principal, {
      name: 'App',
      slug: `app-${randomUUID()}`,
      description: '',
    });

    const bytes = Buffer.from('notification fixture');

    const artifact = await control.artifact(
      tx,
      principal,
      { project_id: project.id, name: 'application', version: '1.0', digest: sha256(bytes) },
      bytes,
    );

    const release = await control.release(tx, principal, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: '1.0',
      process: deploymentProcess(),
    });

    return control.deploy(tx, principal, {
      release_id: release.id,
      environment_id: f.environments.staging,
    });
  });
}

function worker(transport: NotificationTransport = async () => ({ status: 204 })) {
  return new NotificationWorker(db, vault, transport, ['https://receiver.example']);
}

async function row() {
  return (
    await db.query(
      `
        SELECT
          *
        FROM
          notification_deliveries
        WHERE
          organisation_id = $1
        ORDER BY
          created_at DESC
        LIMIT
          1
      `,
      [f.org],
    )
  ).rows[0];
}

async function due() {
  await db.query("UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second'");
}

it('enqueues matching event snapshots atomically, deduplicates events and protects metadata', async () => {
  const dest = await endpoint();

  await endpoint({ name: 'Production only', environment_id: f.environments.production });
  const d = await deployment();

  expect((await get('notification-deliveries')).json().total).toBe(1);
  const job = await row();

  expect(job.payload).toMatchObject({
    type: 'deployment.queued',
    deployment: { id: d.id, status: 'queued', project_name: 'App', release_version: '1.0' },
  });

  await transaction(db, (tx) => enqueueNotifications(tx, d, job.event_id));
  expect((await get('notification-deliveries')).json().total).toBe(1);
  const metadata = (await get('notification-endpoints')).body;

  for (const privateValue of [
    secret,
    'private-token',
    'private-query',
    'credentials',
    'ciphertext',
  ]) {
    expect(metadata).not.toContain(privateValue);
  }

  expect(metadata).toContain('https://receiver.example');

  const encrypted = (
    await db.query('SELECT credentials FROM notification_endpoints WHERE id=$1', [dest.id])
  ).rows[0];

  expect(JSON.stringify(encrypted)).not.toContain(secret);
  const before = (await get('notification-deliveries')).json().total;

  await expect(
    transaction(db, async (tx) => {
      await control.deploymentEvent(tx, await control.authenticate(f.operator.token), {
        ...d,
        status: 'failed',
      });

      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');

  expect((await get('notification-deliveries')).json().total).toBe(before);
});

it('validates destinations and scopes, enforces permissions, idempotency and workspace isolation', async () => {
  const input = { name: 'Ops', url, signing_secret: secret, statuses: ['queued'] };

  expect((await post('/notifications/endpoints', input, f.reader.token)).statusCode).toBe(403);

  for (const invalid of [
    'http://receiver.example/a',
    'https://receiver.example.evil/a',
    'https://user:password@receiver.example/a',
    'https://receiver.example/a#secret',
    'https://127.0.0.1/',
  ]) {
    expect((await post('/notifications/endpoints', { ...input, url: invalid })).statusCode).toBe(
      400,
    );
  }

  expect(
    (await post('/notifications/endpoints', { ...input, signing_secret: 'short' })).body,
  ).not.toContain('short');

  const other = await fixture(db);

  expect(
    (
      await post('/notifications/endpoints', {
        ...input,
        environment_id: other.environments.staging,
      })
    ).statusCode,
  ).toBe(404);

  const key = randomUUID();
  const a = await post('/notifications/endpoints', input, f.operator.token, key);
  const b = await post('/notifications/endpoints', input, f.operator.token, key);

  expect(a.json().id).toBe(b.json().id);
  await deployment();
  expect((await get('notification-endpoints', other.reader.token)).json().total).toBe(0);

  expect((await get(`notification-endpoints/${a.json().id}`, other.reader.token)).statusCode).toBe(
    404,
  );

  const job = await row();

  expect(
    (await post(`/notifications/deliveries/${job.id}/retry`, {}, other.operator.token)).statusCode,
  ).toBe(409);

  expect((await get('notification-deliveries', other.reader.token)).json().total).toBe(0);
});

it('signs deliveries, retries transient failures, records history and keeps stable delivery IDs', async () => {
  await endpoint();
  await deployment();
  const seen: string[] = [];

  const send: NotificationTransport = async (destination, body, headers) => {
    expect(destination.href).toBe(url);

    expect(headers['x-keel-signature']).toBe(
      `sha256=${createHmac('sha256', secret).update(`${headers['x-keel-timestamp']}.${headers['x-keel-delivery']}.${body}`).digest('hex')}`,
    );

    expect(body).not.toContain(secret);
    seen.push(headers['x-keel-delivery']);

    return { status: seen.length === 1 ? 429 : 204, retryAfter: '120' };
  };

  await worker(send).runOnce();
  let job = await row();

  expect(job).toMatchObject({ status: 'retrying', attempt_count: 1, last_http_status: 429 });
  expect(new Date(job.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(115_000);
  expect(await worker(send).runOnce()).toBe(false);
  await due();
  await worker(send).runOnce();
  job = await row();
  expect(job).toMatchObject({ status: 'delivered', attempt_count: 2, last_code: 'ACCEPTED' });
  expect(seen[0]).toBe(seen[1]);

  expect(
    (await get(`notification-attempts?delivery_id=${job.id}`))
      .json()
      .items.map((v: { code: string }) => v.code)
      .sort(),
  ).toEqual(['ACCEPTED', 'HTTP_ERROR']);

  expect((await post(`/notifications/deliveries/${job.id}/retry`, {})).statusCode).toBe(409);
});

it('exhausts six attempts, permits explicit retry and stops permanent HTTP failures', async () => {
  await endpoint();
  await deployment();

  for (let i = 0; i < 6; i++) {
    await due();

    await worker(async () => {
      throw new Error('private upstream detail');
    }).runOnce();
  }

  let job = await row();

  expect(job).toMatchObject({ status: 'failed', attempt_count: 6, last_code: 'NETWORK_ERROR' });
  expect((await get('notification-deliveries')).body).not.toContain('private upstream');
  expect((await post(`/notifications/deliveries/${job.id}/retry`, {})).statusCode).toBe(200);
  await worker(async () => ({ status: 302 })).runOnce();
  job = await row();

  expect(job).toMatchObject({
    status: 'failed',
    attempt_count: 7,
    cycle_attempts: 1,
    last_http_status: 302,
  });
});

it('claims exclusively and rejects late completion after lease recovery', async () => {
  await endpoint();
  await deployment();
  let finish!: (value: { status: number }) => void;
  let started!: () => void;

  const began = new Promise<void>((resolve) => {
    started = resolve;
  });

  const first = worker(async () => {
    started();

    return new Promise((resolve) => {
      finish = resolve;
    });
  }).runOnce();

  await began;
  expect(await worker().runOnce()).toBe(false);
  await db.query("UPDATE notification_deliveries SET lease_expires_at=now()-interval '1 second'");
  await worker(async () => ({ status: 400 })).runOnce();
  finish({ status: 200 });
  await first;
  const job = await row();

  expect(job).toMatchObject({ status: 'failed', attempt_count: 2, last_http_status: 400 });

  expect(
    (await get(`notification-attempts?delivery_id=${job.id}`))
      .json()
      .items.map((a: { code: string }) => a.code)
      .sort(),
  ).toEqual(['HTTP_ERROR', 'LEASE_EXPIRED']);
});

it('disables pending jobs, rejects stale revisions and quarantines restored queues', async () => {
  const dest = await endpoint();
  const d = await deployment();

  expect(
    (
      await post(`/notifications/endpoints/${dest.id}/state`, {
        enabled: false,
        expected_revision: 1,
      })
    ).statusCode,
  ).toBe(200);

  expect((await row()).status).toBe('cancelled');

  expect(
    (
      await post(`/notifications/endpoints/${dest.id}/state`, {
        enabled: true,
        expected_revision: 1,
      })
    ).statusCode,
  ).toBe(409);

  expect((await post(`/notifications/deliveries/${(await row()).id}/retry`, {})).statusCode).toBe(
    409,
  );

  await post(`/notifications/endpoints/${dest.id}/state`, { enabled: true, expected_revision: 2 });

  await transaction(db, (tx) =>
    control.deploymentEvent(
      tx,
      { organisation_id: f.org, actor_id: f.operator.id, name: 'operator', permissions: ['write'] },
      { ...d, status: 'failed' },
    ),
  );

  await quarantine(db);

  expect(
    (await get('notification-endpoints'))
      .json()
      .items.every((e: { enabled: boolean }) => !e.enabled),
  ).toBe(true);

  expect(await worker().runOnce()).toBe(false);
  expect((await row()).last_code).toBe('RESTORE_QUARANTINE');
});

it('rechecks the server origin allowlist before sending and bounds attempt filters', async () => {
  await endpoint();
  await deployment();
  const send = vi.fn(async () => ({ status: 200 }));

  await new NotificationWorker(db, vault, send, []).runOnce();
  expect(send).not.toHaveBeenCalled();
  expect((await row()).last_code).toBe('INVALID_DESTINATION');
  expect((await get('notification-deliveries?limit=101')).statusCode).toBe(400);
  expect((await get(`notification-attempts?delivery_id=${randomUUID()}`)).json().total).toBe(0);
});

it('creates, lists, disables and retries notifications through the CLI', async () => {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const config = join(root, 'webhook.json');

  await writeFile(config, JSON.stringify({ name: 'CLI alerts', url, statuses: ['queued'] }));

  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)('node_modules/.bin/tsx', ['apps/cli/src/main.ts', ...args], {
          env: {
            ...process.env,
            KEEL_URL: address,
            KEEL_TOKEN: f.operator.token,
            KEEL_NOTIFICATION_SECRET: secret,
          },
        })
      ).stdout,
    );

  const endpoint = await cli('notification', 'create', '--config', config);

  expect(endpoint.name).toBe('CLI alerts');
  expect(JSON.stringify(endpoint)).not.toContain(secret);
  await deployment();
  await worker(async () => ({ status: 400 })).runOnce();

  const page = await cli(
    'list',
    'notification-deliveries',
    '--endpoint',
    endpoint.id,
    '--status',
    'failed',
  );

  expect(page.total).toBe(1);

  expect((await cli('list', 'notification-attempts', '--delivery', page.items[0].id)).total).toBe(
    1,
  );

  expect((await cli('notification', 'retry', page.items[0].id)).status).toBe('pending');

  expect((await cli('notification', 'disable', endpoint.id, '--revision', '1')).enabled).toBe(
    false,
  );

  expect((await row()).status).toBe('cancelled');
});
