import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../../packages/database/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';

const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let app: FastifyInstance,
  root: string,
  service: ControlPlane,
  f: Awaited<ReturnType<typeof fixture>>;
const bytes = Buffer.from('retained application build v1');

async function post(path: string, body: unknown, token = f.operator.token, key = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
      'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
    },
    payload: body as never,
  });
}

async function get(path: string, token = f.operator.token) {
  return app.inject({
    method: 'GET',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function project() {
  const r = await post('/projects', { name: 'Portal', slug: `portal-${randomUUID()}` });

  expect(r.statusCode).toBe(200);

  return r.json();
}

async function artifact(projectId: string) {
  const q = new URLSearchParams({
    project_id: projectId,
    name: 'application',
    version: '1.0.0',
    digest: sha256(bytes),
  });

  const r = await post(`/artifacts?${q}`, bytes);

  expect(r.statusCode).toBe(200);

  return r.json();
}

async function release(approval = true) {
  const p = await project();
  const a = await artifact(p.id);

  const r = await post('/releases', {
    project_id: p.id,
    artifact_id: a.id,
    version: '1.0.0',
    process: deploymentProcess(approval),
  });

  expect(r.statusCode).toBe(200);

  return r.json();
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-test-'));
  service = new ControlPlane(db, new LocalArtifactStore(root));
});

beforeEach(async () => {
  f = await fixture(db);
  app = await createApp(service);
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

describe('control plane against PostgreSQL', () => {
  it('publishes and creates a release through the CLI against the live API', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const p = await project();
    const file = join(root, 'cli-artifact.bin');

    await writeFile(file, bytes);

    const run = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', 'apps/cli/src/main.ts', ...args],
        {
          env: { ...process.env, KEEL_URL: address, KEEL_TOKEN: f.operator.token },
        },
      );

      return JSON.parse(stdout);
    };

    const a = await run(
      'artifact',
      'publish',
      file,
      '--project',
      p.id,
      '--name',
      'application',
      '--version',
      '1.0.0',
      '--idempotency-key',
      'cli-build-artifact',
    );

    expect(a.digest).toBe(sha256(bytes));

    const r = await run(
      'release',
      'create',
      '--project',
      p.id,
      '--artifact',
      a.id,
      '--version',
      '1.0.0',
      '--process',
      'examples/process.yaml',
      '--idempotency-key',
      'cli-build-release',
    );

    expect(r.manifest.artifact.digest).toBe(a.digest);
    expect((await run('status', '--json')).releases).toHaveLength(1);
    expect((await run('validate', 'examples/process.yaml')).valid).toBe(true);
  });

  it('requires a valid non-revoked token and derives organisation from it', async () => {
    expect((await app.inject('/api/v1/snapshot')).statusCode).toBe(401);
    expect((await get('/snapshot', 'invalid-token-long-enough')).statusCode).toBe(401);
    await db.query('UPDATE api_tokens SET revoked_at=now() WHERE actor_id=$1', [f.operator.id]);
    expect((await get('/snapshot')).statusCode).toBe(401);
  });

  it('rejects organisation spoofing and caller-controlled deployment state', async () => {
    expect(
      (await post('/projects', { name: 'Portal', slug: 'portal', organisation_id: randomUUID() }))
        .statusCode,
    ).toBe(400);

    expect(
      (
        await post('/deployments', {
          release_id: randomUUID(),
          environment_id: randomUUID(),
          status: 'succeeded',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('deduplicates simultaneous requests, including audit records', async () => {
    const key = randomUUID();
    const input = { name: 'Portal', slug: 'portal' };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => post('/projects', input, f.operator.token, key)),
    );

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const snapshot = (await get('/snapshot')).json();

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.audit).toHaveLength(1);
  });

  it('rejects idempotency key reuse with a different payload and survives API recreation', async () => {
    const key = randomUUID();
    const input = { name: 'Portal', slug: 'portal' };
    const first = await post('/projects', input, f.operator.token, key);

    expect(
      (await post('/projects', { ...input, name: 'Other' }, f.operator.token, key)).statusCode,
    ).toBe(409);

    await app.close();
    app = await createApp(service);
    expect((await post('/projects', input, f.operator.token, key)).json()).toEqual(first.json());
  });

  it('requires idempotency on writes and denies write access to read-only tokens', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${f.operator.token}` },
      payload: { name: 'Portal', slug: 'portal' },
    });

    expect(r.statusCode).toBe(400);

    expect(
      (await post('/projects', { name: 'Portal', slug: 'portal' }, f.reader.token)).statusCode,
    ).toBe(403);
  });

  it('verifies artifact bytes before creating metadata and returns the retained copy', async () => {
    const p = await project();

    const q = new URLSearchParams({
      project_id: p.id,
      name: 'application',
      version: 'bad',
      digest: '0'.repeat(64),
    });

    const bad = await post(`/artifacts?${q}`, bytes);

    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('DIGEST_MISMATCH');
    expect((await get('/snapshot')).json().artifacts).toHaveLength(0);
    const a = await artifact(p.id);
    const downloaded = await get(`/artifacts/${a.id}/download`);

    expect(downloaded.rawPayload).toEqual(bytes);
  });

  it('prevents artifact version replacement and immutable database updates', async () => {
    const p = await project();
    const a = await artifact(p.id);

    const q = new URLSearchParams({
      project_id: p.id,
      name: 'application',
      version: '1.0.0',
      digest: sha256(Buffer.from('replacement')),
    });

    expect((await post(`/artifacts?${q}`, Buffer.from('replacement'))).statusCode).toBe(409);

    await expect(
      db.query("UPDATE artifacts SET version='changed' WHERE id=$1", [a.id]),
    ).rejects.toMatchObject({ code: '23514' });

    expect((await get(`/artifacts/${a.id}/download`)).rawPayload).toEqual(bytes);
  });

  it('captures the exact artifact and process in a release and rejects edits', async () => {
    const r = await release();

    expect(r.manifest.artifact.digest).toBe(sha256(bytes));
    expect(r.manifest.process).toEqual(deploymentProcess());

    await expect(
      db.query("UPDATE releases SET version='2' WHERE id=$1", [r.id]),
    ).rejects.toMatchObject({
      code: '23514',
    });

    await expect(
      db.query('DELETE FROM audit_events WHERE organisation_id=$1', [f.org]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('prevents cross-organisation reads, artifact access and release references', async () => {
    const r = await release();
    const other = await fixture(db);

    expect((await get('/snapshot', other.operator.token)).json().releases).toHaveLength(0);

    expect(
      (await get(`/artifacts/${r.artifact_id}/download`, other.operator.token)).statusCode,
    ).toBe(404);

    expect(
      (
        await post(
          '/releases',
          {
            project_id: r.project_id,
            artifact_id: r.artifact_id,
            version: '2.0',
            process: deploymentProcess(),
          },
          other.operator.token,
        )
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await post(
          '/deployments',
          { release_id: r.id, environment_id: other.environments.staging },
          other.operator.token,
        )
      ).statusCode,
    ).toBe(404);

    await expect(
      db.query(
        `
          INSERT INTO
            releases (
              id,
              organisation_id,
              project_id,
              version,
              artifact_id,
              manifest
            )
          VALUES
            ($1, $2, $3, $4, $5, $6)
        `,
        [randomUUID(), other.org, r.project_id, 'bad', r.artifact_id, r.manifest],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects artifact references from a different project within the same organisation', async () => {
    const r = await release();
    const p = await project();

    expect(
      (
        await post('/releases', {
          project_id: p.id,
          artifact_id: r.artifact_id,
          version: '2',
          process: deploymentProcess(),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('retains the same release digest across staging and production requests', async () => {
    const r = await release();

    const stage = await post('/deployments', {
      release_id: r.id,
      environment_id: f.environments.staging,
    });

    const production = await post('/deployments', {
      release_id: r.id,
      environment_id: f.environments.production,
    });

    expect(stage.json().status).toBe('queued');
    expect(production.json().status).toBe('awaiting_approval');
    expect(stage.json().release_id).toBe(production.json().release_id);
    expect((await get('/snapshot')).json().releases).toHaveLength(1);
  });

  it('cannot weaken production approval in the process and requires a different identity', async () => {
    const r = await release(false);

    const d = (
      await post('/deployments', { release_id: r.id, environment_id: f.environments.production })
    ).json();

    expect(d.status).toBe('awaiting_approval');
    expect((await post(`/deployments/${d.id}/approve`, {})).statusCode).toBe(403);

    await db.query(
      `
      UPDATE api_tokens
      SET
        permissions = ARRAY['read', 'write', 'approve']
      WHERE
        actor_id = $1
    `,
      [f.operator.id],
    );

    const self = await post(`/deployments/${d.id}/approve`, {});

    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('SELF_APPROVAL');
    const approved = await post(`/deployments/${d.id}/approve`, {}, f.approver.token);

    expect(approved.json().status).toBe('queued');
    expect(approved.json().approved_by).toBe(f.approver.id);
  });

  it('uses a database lock to prevent concurrent requests to the same project and environment', async () => {
    const r = await release();

    const results = await Promise.all([
      post('/deployments', { release_id: r.id, environment_id: f.environments.staging }),
      post('/deployments', { release_id: r.id, environment_id: f.environments.staging }),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);

    expect(
      (await db.query('SELECT * FROM outbox WHERE organisation_id=$1', [f.org])).rowCount,
    ).toBe(1);
  });

  it('deduplicates deployment retries and emits exactly one durable event', async () => {
    const r = await release();
    const key = randomUUID();
    const body = { release_id: r.id, environment_id: f.environments.production };
    const first = await post('/deployments', body, f.operator.token, key);

    expect((await post('/deployments', body, f.operator.token, key)).json()).toEqual(first.json());

    expect(
      (await db.query('SELECT * FROM deployment_events WHERE organisation_id=$1', [f.org]))
        .rowCount,
    ).toBe(1);

    expect(
      (await db.query('SELECT * FROM outbox WHERE organisation_id=$1', [f.org])).rowCount,
    ).toBe(1);
  });

  it('rejects late approval after cancellation and releases the environment lock', async () => {
    const r = await release();
    const input = { release_id: r.id, environment_id: f.environments.production };
    const d = (await post('/deployments', input)).json();

    expect((await post(`/deployments/${d.id}/cancel`, {})).json().status).toBe('cancelled');
    expect((await post(`/deployments/${d.id}/approve`, {}, f.approver.token)).statusCode).toBe(409);
    expect((await post('/deployments', input)).statusCode).toBe(200);
  });

  it('separates approval rejection from cancellation and preserves the decision', async () => {
    const r = await release();

    const d = (
      await post('/deployments', { release_id: r.id, environment_id: f.environments.production })
    ).json();

    expect((await post(`/deployments/${d.id}/reject`, {}, f.approver.token)).json().status).toBe(
      'rejected',
    );

    expect((await post(`/deployments/${d.id}/approve`, {}, f.approver.token)).statusCode).toBe(409);

    expect(
      (
        await db.query(
          `
          SELECT
            status
          FROM
            deployment_events
          WHERE
            deployment_id = $1
          ORDER BY
            created_at
        `,
          [d.id],
        )
      ).rows.map((r) => r.status),
    ).toEqual(['awaiting_approval', 'rejected']);
  });

  it('refuses corrupted or missing retained artifacts during deployment and approval', async () => {
    const r = await release();

    const d = (
      await post('/deployments', { release_id: r.id, environment_id: f.environments.production })
    ).json();

    const path = join(root, f.org, sha256(bytes));

    await writeFile(path, 'corrupt');

    expect(
      (
        await post('/deployments', { release_id: r.id, environment_id: f.environments.staging })
      ).json().error.code,
    ).toBe('ARTIFACT_CORRUPT');

    expect(
      (await post(`/deployments/${d.id}/approve`, {}, f.approver.token)).json().error.code,
    ).toBe('ARTIFACT_CORRUPT');

    await unlink(path);

    expect((await get(`/artifacts/${r.artifact_id}/download`)).json().error.code).toBe(
      'ARTIFACT_UNAVAILABLE',
    );

    expect((await get('/snapshot')).json().deployments[0].status).toBe('awaiting_approval');
  });

  it('advertises only implemented providers and rejects agent execution endpoints', async () => {
    const providers = (await get('/providers')).json().providers;

    expect(providers).toHaveLength(5);

    expect(
      providers.filter((p: { available: boolean }) => p.available).map((p: { id: string }) => p.id),
    ).toEqual(['github-actions', 'bitbucket-pipelines']);

    expect((await post('/deployments/complete', { status: 'succeeded' })).statusCode).toBe(404);
  });
});
