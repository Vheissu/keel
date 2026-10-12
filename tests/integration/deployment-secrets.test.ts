import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../packages/database/src/migrate.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { ExecutionService, type AgentIdentity } from '../../apps/api/src/execution-service.js';
import { createApp } from '../../apps/api/src/app.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';

const schema = `secrets_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const key = randomBytes(32).toString('base64');
let root: string;
let control: ControlPlane;
let execution: ExecutionService;
let app: Awaited<ReturnType<typeof createApp>>;
let f: Awaited<ReturnType<typeof fixture>>;
let managerToken: string;
let project: { id: string };
let agent: AgentIdentity;
const value = 'test-private-value = # $ " with spaces';

async function post(
  path: string,
  payload: unknown,
  token = f.operator.token,
  idempotency = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotency,
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

function input(environment = f.environments.staging, secretValue = value) {
  return {
    project_id: project.id,
    environment_id: environment,
    name: 'DATABASE_PASSWORD',
    value: secretValue,
  };
}

async function secret(environment = f.environments.staging, secretValue = value) {
  const response = await post('/secrets', input(environment, secretValue), managerToken);

  expect(response.statusCode, response.body).toBe(200);

  return response.json();
}

async function release(version: string = randomUUID()) {
  const bytes = Buffer.from(`retained:${version}`);

  const artifact = await post(
    `/artifacts?${new URLSearchParams({ project_id: project.id, name: 'application', version, digest: sha256(bytes) })}`,
    bytes,
  );

  const process = deploymentProcess();

  Object.assign(process.spec.artifact, { dockerImageId: `sha256:${'a'.repeat(64)}` });

  for (const environment of Object.values(process.spec.environments)) {
    Object.assign(environment, {
      strategy: 'recreate',
      verify: { http: { path: '/' } },
      secrets: { APP_PASSWORD: { secret: 'DATABASE_PASSWORD' } },
    });
  }

  const result = await post('/releases', {
    project_id: project.id,
    artifact_id: artifact.json().id,
    version,
    process,
  });

  expect(result.statusCode, result.body).toBe(200);

  return result.json();
}

async function deploy(releaseId: string, environment = f.environments.staging) {
  const result = await post('/deployments', { release_id: releaseId, environment_id: environment });

  expect(result.statusCode, result.body).toBe(200);

  return result.json();
}

async function claim(deployment: { id: string }) {
  await execution.tick(f.org, deployment.id);
  const job = await execution.claim(agent, true);

  expect(job).not.toBeNull();

  return job!;
}

async function finish(releaseId: string) {
  const deployment = await deploy(releaseId);
  const job = await claim(deployment);

  await execution.complete(agent, {
    attempt_id: job.attempt_id,
    fence: job.fence,
    token: job.token,
    outcome: 'succeeded',
    code: 'HTTP_VERIFIED',
  });

  return deployment;
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-secrets-'));

  control = new ControlPlane(
    db,
    new LocalArtifactStore(root),
    new CredentialVault(key, 'deployment-secrets'),
  );

  execution = new ExecutionService(control);
});

beforeEach(async () => {
  f = await fixture(db);
  app = await createApp(control);
  managerToken = randomBytes(32).toString('hex');
  const manager = randomUUID();

  await db.query('INSERT INTO actors(id,organisation_id,name) VALUES($1,$2,$3)', [
    manager,
    f.org,
    'Secret manager',
  ]);

  await db.query(
    `
      INSERT INTO
        api_tokens (
          id,
          organisation_id,
          actor_id,
          token_hash,
          permissions
        )
      VALUES
        ($1, $2, $3, $4, $5)
    `,
    [randomUUID(), f.org, manager, sha256(managerToken), ['read', 'manage_secrets']],
  );

  project = (await post('/projects', { name: 'Scoped service', slug: 'scoped' })).json();
  const fingerprint = randomBytes(32).toString('hex');

  await post('/agents', { name: 'Secret host', certificate_fingerprint: fingerprint });
  agent = await execution.authenticate(fingerprint);

  for (const [slug, environment] of Object.entries(f.environments)) {
    await post('/targets', {
      name: slug,
      project_id: project.id,
      environment_id: environment,
      agent_id: agent.id,
      labels: { tier: slug },
    });
  }
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

describe('Scoped deployment secrets', () => {
  it('keeps request bodies and unexpected failures out of API logs', async () => {
    await app.close();
    let logs = '';

    app = await createApp(control, {
      stream: {
        write: (line: string) => {
          logs += line;
        },
      },
    });

    const marker = `private-log-canary-${randomUUID()}`;
    const failure = vi.spyOn(control.secrets, 'create').mockRejectedValueOnce(new Error(marker));

    try {
      const response = await post('/secrets', input(f.environments.staging, marker), managerToken);

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(marker);
      const malformed = await post('/secrets', `{"value":"${marker}`, managerToken);

      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).not.toContain(marker);
      await app.close();
      expect(logs).toContain('SECRET_OPERATION_FAILED');
      expect(logs).not.toContain(marker);
      expect(logs).not.toContain(managerToken);
    } finally {
      failure.mockRestore();
    }
  });

  it('does not fall back to another project and enforces binding scope in PostgreSQL', async () => {
    const saved = await secret();
    const originalProject = project;
    const otherProject = (await post('/projects', { name: 'Other project', slug: 'other' })).json();

    project = otherProject;
    const otherRelease = await release();

    expect(
      (
        await post('/deployments', {
          release_id: otherRelease.id,
          environment_id: f.environments.staging,
        })
      ).json().error.code,
    ).toBe('SECRET_UNAVAILABLE');

    await secret(f.environments.staging, 'other-project-only');

    await post('/targets', {
      name: 'Other project target',
      project_id: otherProject.id,
      environment_id: f.environments.staging,
      agent_id: agent.id,
      labels: { tier: 'staging' },
    });

    const deployment = await deploy(otherRelease.id);
    const job = await claim(deployment);

    expect(await execution.secrets(agent, job)).toEqual({
      values: { APP_PASSWORD: 'other-project-only' },
    });

    await expect(
      db.query(
        `
          INSERT INTO
            deployment_secret_bindings (
              organisation_id,
              project_id,
              environment_id,
              deployment_id,
              variable,
              secret_id,
              version
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7)
        `,
        [f.org, otherProject.id, f.environments.staging, deployment.id, 'FOREIGN', saved.id, 1],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      db.query('DELETE FROM deployment_secret_bindings WHERE deployment_id=$1', [deployment.id]),
    ).rejects.toMatchObject({ code: '23514' });

    project = originalProject;
  });

  it('separates secret management from operator and approver permissions', async () => {
    for (const token of [f.operator.token, f.approver.token, f.reader.token]) {
      expect((await post('/secrets', input(), token)).statusCode).toBe(403);
    }

    const saved = await secret();

    expect(
      (await post(`/secrets/${saved.id}/versions`, { value: 'next', expected_revision: 1 }))
        .statusCode,
    ).toBe(403);

    expect(
      (await post(`/secrets/${saved.id}/revoke`, { expected_revision: 1 }, f.approver.token))
        .statusCode,
    ).toBe(403);

    expect(
      (await post('/projects', { name: 'Denied', slug: 'denied' }, managerToken)).statusCode,
    ).toBe(403);

    const deployment = await deploy((await release()).id);

    expect((await post(`/deployments/${deployment.id}/approve`, {}, managerToken)).statusCode).toBe(
      403,
    );
  });

  it('encrypts values and excludes them from reads, immutable manifests, audits and retry records', async () => {
    const idempotency = randomUUID();
    const saved = await post('/secrets', input(), managerToken, idempotency);
    const replay = await post('/secrets', input(), managerToken, idempotency);

    expect(replay.json()).toEqual(saved.json());
    expect(saved.headers['cache-control']).toBe('no-store');

    expect(
      (await post('/secrets', { ...input(), value: 'changed' }, managerToken, idempotency))
        .statusCode,
    ).toBe(409);

    const releaseRecord = await release();
    const deployment = await deploy(releaseRecord.id);

    const metadata = await get(
      `/secrets?project_id=${project.id}&environment_id=${f.environments.staging}`,
      f.reader.token,
    );

    expect(metadata.json()[0]).toMatchObject({ name: 'DATABASE_PASSWORD', current_version: 1 });
    expect((await get(`/secrets/${saved.json().id}/value`)).statusCode).toBe(404);
    const bindings = await get(`/deployments/${deployment.id}/secret-bindings`);

    expect(bindings.json()).toEqual([
      { name: 'DATABASE_PASSWORD', variable: 'APP_PASSWORD', version: 1, revoked_at: null },
    ]);

    const snapshot = await get('/snapshot');

    const stored = await db.query(
      'SELECT encrypted_value FROM deployment_secret_versions WHERE organisation_id=$1',
      [f.org],
    );

    const retries = await db.query(
      'SELECT request_hash, response FROM idempotency_keys WHERE organisation_id=$1',
      [f.org],
    );

    const persistedEvents = await db.query('SELECT payload FROM outbox WHERE organisation_id=$1', [
      f.org,
    ]);

    const all = JSON.stringify([
      saved.json(),
      metadata.json(),
      snapshot.json(),
      bindings.json(),
      stored.rows,
      retries.rows,
      persistedEvents.rows,
    ]);

    expect(all).not.toContain(value);
    expect(all).not.toContain('test-private-value');
    expect(all).not.toContain(sha256(value));
    expect(all).not.toContain(sha256(`create:${JSON.stringify(input())}`));
    expect(stored.rows[0].encrypted_value.ciphertext).toBeTruthy();
  });

  it('rejects invalid values without echoing them, including malformed JSON and unexpected keys', async () => {
    for (const invalid of [
      '',
      'line1\nline2',
      'line1\rline2',
      'nul\0value',
      'x'.repeat(8193),
      '😀'.repeat(2049),
      '\ud800',
    ]) {
      const response = await post('/secrets', { ...input(), value: invalid }, managerToken);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_SECRET_INPUT');
    }

    const unexpected = await post('/secrets', { ...input(), [value]: 'bad' }, managerToken);
    const malformed = await post('/secrets', `{"value": "${value}`, managerToken);

    expect(unexpected.body).not.toContain(value);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(value);

    expect(
      (await post('/secrets', input(f.environments.staging, '😀'.repeat(2048)), managerToken))
        .statusCode,
    ).toBe(200);
  });

  it('requires the exact project/environment scope, without inheritance or cross-workspace references', async () => {
    const other = await fixture(db);
    const saved = await secret();
    const r = await release();

    expect(
      (
        await post('/deployments', { release_id: r.id, environment_id: f.environments.production })
      ).json().error.code,
    ).toBe('SECRET_UNAVAILABLE');

    const eligibility = await get(
      `/releases/${r.id}/promotion?environment_id=${f.environments.production}`,
    );

    expect(eligibility.json()).toMatchObject({
      eligible: false,
      secret_bindings: [{ variable: 'APP_PASSWORD', available: false }],
    });

    expect(
      (await get(`/secrets?project_id=${project.id}&environment_id=${other.environments.staging}`))
        .statusCode,
    ).toBe(404);

    expect(
      (
        await post(
          '/secrets',
          { ...input(), environment_id: other.environments.production },
          managerToken,
        )
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await get(
          `/secrets?project_id=${project.id}&environment_id=${f.environments.staging}`,
          other.reader.token,
        )
      ).statusCode,
    ).toBe(404);

    const manager = await control.authenticate(managerToken);

    await expect(
      control.mutate({ ...manager, organisation_id: other.org }, randomUUID(), 'foreign', (tx) =>
        control.secrets.rotate(tx, { ...manager, organisation_id: other.org }, saved.id, {
          value: 'bad',
          expected_revision: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await secret(f.environments.production, 'production-only');
    const deployment = await deploy(r.id, f.environments.production);

    expect(deployment.status).toBe('awaiting_approval');
    await execution.tick(f.org, deployment.id);
    expect(await execution.claim(agent, true)).toBeNull();
    await post(`/deployments/${deployment.id}/approve`, {}, f.approver.token);
    const job = await claim(deployment);

    expect(await execution.secrets(agent, job)).toEqual({
      values: { APP_PASSWORD: 'production-only' },
    });
  });

  it('pins versions at admission and requires capable agents, with rotation affecting only new requests', async () => {
    const saved = await secret();
    const r = await release();
    const deployment = await deploy(r.id);

    const rotated = await post(
      `/secrets/${saved.id}/versions`,
      { value: 'next-version', expected_revision: 1 },
      managerToken,
    );

    expect(rotated.json()).toMatchObject({ current_version: 2, revision: 2 });

    expect(
      (
        await post(
          `/secrets/${saved.id}/versions`,
          { value: 'stale', expected_revision: 1 },
          managerToken,
        )
      ).json().error.code,
    ).toBe('SECRET_CHANGED');

    await execution.tick(f.org, deployment.id);
    expect(await execution.claim(agent)).toBeNull();
    const job = (await execution.claim(agent, true))!;

    expect(job.secret_count).toBe(1);
    expect(JSON.stringify(job)).not.toContain(value);
    expect(await execution.secrets(agent, job)).toEqual({ values: { APP_PASSWORD: value } });
    await execution.complete(agent, { ...job, outcome: 'succeeded', code: 'HTTP_VERIFIED' });
    const second = await deploy(r.id);
    const secondJob = await claim(second);

    expect(await execution.secrets(agent, secondJob)).toEqual({
      values: { APP_PASSWORD: 'next-version' },
    });
  });

  it('serializes competing rotations and authenticates each version against its scope', async () => {
    const saved = await secret();

    const responses = await Promise.all(
      ['first', 'second'].map((value) =>
        post(`/secrets/${saved.id}/versions`, { value, expected_revision: 1 }, managerToken),
      ),
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const encrypted = (
      await db.query(
        `
          SELECT
            encrypted_value
          FROM
            deployment_secret_versions
          WHERE
            secret_id = $1
            AND version = 1
        `,
        [saved.id],
      )
    ).rows[0].encrypted_value;

    const vault = new CredentialVault(key, 'deployment-secrets');
    const context = `${project.id}:${f.environments.staging}:${saved.id}:DATABASE_PASSWORD:1`;

    expect(vault.decrypt(f.org, context, encrypted)).toBe(value);
    expect(() => vault.decrypt(f.org, context.replace(':1', ':2'), encrypted)).toThrow();

    expect(() =>
      vault.decrypt(
        f.org,
        context.replace(f.environments.staging, f.environments.production),
        encrypted,
      ),
    ).toThrow();

    expect(() => new CredentialVault(key).decrypt(f.org, context, encrypted)).toThrow();

    await expect(
      db.query('UPDATE deployment_secret_versions SET encrypted_value=$1 WHERE secret_id=$2', [
        {},
        saved.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      db.query('UPDATE deployment_secrets SET name=$1 WHERE id=$2', ['RENAMED', saved.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('revokes every pinned version and keeps revocation effective after a new version is added', async () => {
    const saved = await secret();
    const deployment = await deploy((await release()).id);
    const job = await claim(deployment);

    await post(
      `/secrets/${saved.id}/versions`,
      { value: 'second', expected_revision: 1 },
      managerToken,
    );

    expect(
      (await post(`/secrets/${saved.id}/revoke`, { expected_revision: 2 }, managerToken))
        .statusCode,
    ).toBe(200);

    await expect(execution.secrets(agent, job)).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });

    const restored = await post(
      `/secrets/${saved.id}/versions`,
      { value: 'third', expected_revision: 3 },
      managerToken,
    );

    expect(restored.json()).toMatchObject({ disabled: false, current_version: 3, revision: 4 });

    await expect(execution.secrets(agent, job)).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });

    expect(
      (await get(`/deployments/${deployment.id}/secret-bindings`)).json()[0].revoked_at,
    ).toBeTruthy();

    await expect(
      db.query(
        `
          UPDATE deployment_secret_versions
          SET
            revoked_at = NULL
          WHERE
            secret_id = $1
            AND version = 1
        `,
        [saved.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('denies other agents, wrong tokens and fences, cancelled work, and cleanup-only leases', async () => {
    await secret();
    const deployment = await deploy((await release()).id);
    const job = await claim(deployment);
    const fingerprint = randomBytes(32).toString('hex');

    await post('/agents', { name: 'Other agent', certificate_fingerprint: fingerprint });
    const other = await execution.authenticate(fingerprint);

    await expect(execution.secrets(other, job)).rejects.toMatchObject({ code: 'STALE_LEASE' });

    await expect(execution.secrets(agent, { ...job, token: 'f'.repeat(64) })).rejects.toMatchObject(
      { code: 'STALE_LEASE' },
    );

    await expect(execution.secrets(agent, { ...job, fence: job.fence + 1 })).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });

    await post(`/deployments/${deployment.id}/cancel`, {});
    await expect(execution.secrets(agent, job)).rejects.toMatchObject({ code: 'STALE_LEASE' });

    await db.query(
      "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [job.attempt_id],
    );

    await execution.tick(f.org, deployment.id);
    const cleanup = (await execution.claim(agent))!;

    expect(cleanup.mode).toBe('cleanup');
    expect(cleanup.secret_count).toBe(0);
    await expect(execution.secrets(agent, cleanup)).rejects.toMatchObject({ code: 'STALE_LEASE' });
  });

  it('denies expired leases and revoked certificates without exposing secret material', async () => {
    await secret();
    const deployment = await deploy((await release()).id);
    const job = await claim(deployment);

    await db.query(
      "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [job.attempt_id],
    );

    await expect(execution.secrets(agent, job)).rejects.toMatchObject({ code: 'STALE_LEASE' });
    expect((await post(`/agents/${agent.id}/state`, { state: 'revoked' })).statusCode).toBe(200);

    await expect(execution.secrets(agent, job)).rejects.toMatchObject({
      code: 'AGENT_UNAUTHENTICATED',
    });
  });

  it('keeps secret delivery outside the public API and tolerates unavailable decryption keys safely', async () => {
    const saved = await secret();
    const deployment = await deploy((await release()).id);
    const job = await claim(deployment);
    const withoutKey = new ControlPlane(db, control.store);

    const wrongKey = new ControlPlane(
      db,
      control.store,
      new CredentialVault(randomBytes(32).toString('base64'), 'deployment-secrets'),
    );

    await expect(new ExecutionService(withoutKey).secrets(agent, job)).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });

    await expect(new ExecutionService(wrongKey).secrets(agent, job)).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });

    expect((await post('/agent/v1/secrets', job)).statusCode).toBe(404);
    await app.close();
    app = await createApp(withoutKey);

    expect(
      (await post(`/secrets/${saved.id}/revoke`, { expected_revision: 1 }, managerToken))
        .statusCode,
    ).toBe(200);

    expect((await post('/secrets', { ...input(), name: 'ANOTHER' }, managerToken)).statusCode).toBe(
      503,
    );
  });

  it('reviews current secret versions for rollback and rejects changes after review', async () => {
    const saved = await secret();
    const first = await finish((await release('1')).id);
    const second = await finish((await release('2')).id);

    const reviewed = await post('/rollback-plans', {
      source_deployment_id: second.id,
      candidate_deployment_id: first.id,
    });

    expect(reviewed.statusCode, reviewed.body).toBe(200);

    expect(reviewed.json().secret_bindings).toEqual([
      { variable: 'APP_PASSWORD', name: 'DATABASE_PASSWORD', version: 1 },
    ]);

    await post(
      `/secrets/${saved.id}/versions`,
      { value: 'rollback-current-credential', expected_revision: 1 },
      managerToken,
    );

    expect(
      (
        await post(`/rollback-plans/${reviewed.json().id}/request`, {
          acknowledge_data_not_restored: true,
        })
      ).json().error.code,
    ).toBe('STALE_ROLLBACK');

    const updated = await post('/rollback-plans', {
      source_deployment_id: second.id,
      candidate_deployment_id: first.id,
    });

    const requested = await post(`/rollback-plans/${updated.json().id}/request`, {
      acknowledge_data_not_restored: true,
    });

    expect(requested.statusCode, requested.body).toBe(200);
    const job = await claim(requested.json());

    expect(await execution.secrets(agent, job)).toEqual({
      values: { APP_PASSWORD: 'rollback-current-credential' },
    });
  });

  it('writes values through CLI stdin while stdout and stderr contain metadata only', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const cli = (args: string[], stdin = '') =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', 'apps/cli/src/main.ts', ...args],
          { env: { ...process.env, KEEL_URL: address, KEEL_TOKEN: managerToken } },
        );

        let stdout = '',
          stderr = '';

        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });

        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });

        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(stdin);
      });

    const created = await cli(
      [
        'secret',
        'create',
        '--project',
        project.id,
        '--environment',
        f.environments.staging,
        '--name',
        'DATABASE_PASSWORD',
        '--value-stdin',
      ],
      value,
    );

    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout + created.stderr).not.toContain(value);
    const id = JSON.parse(created.stdout).id;

    const rotated = await cli(
      ['secret', 'rotate', id, '--revision', '1', '--value-stdin'],
      'rotated-cli-value',
    );

    expect(rotated.code, rotated.stderr).toBe(0);
    expect(rotated.stdout + rotated.stderr).not.toContain('rotated-cli-value');

    const invalid = await cli(
      ['secret', 'rotate', id, '--revision', '2', '--value-stdin'],
      `${value}\n`,
    );

    expect(invalid.code).toBe(1);
    expect(invalid.stderr).not.toContain(value);
    const revoked = await cli(['secret', 'revoke', id, '--revision', '2']);

    expect(JSON.parse(revoked.stdout).disabled).toBe(true);
  });
});
