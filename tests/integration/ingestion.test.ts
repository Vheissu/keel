import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../apps/api/src/app.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { IntegrationService } from '../../apps/api/src/integration-service.js';
import { ArtifactImportWorker } from '../../apps/api/src/artifact-import-worker.js';
import { GitHubActionsAdapter } from '../../packages/integrations/src/github-actions.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { deploymentProcess, fixture, testDatabaseUrl } from '../fixtures.js';
import { githubFixture } from '../github-fixture.js';

const schema = `ingestion_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const vault = new CredentialVault(randomBytes(32).toString('base64'));
const webhookSecret = 'webhook-test-secret-with-at-least-32-characters';
const providerToken = 'github-test-access-token-private';
let app: FastifyInstance;
let root: string;
let control: ControlPlane;
let integrations: IntegrationService;
let worker: ArtifactImportWorker;
let f: Awaited<ReturnType<typeof fixture>>;
let github: ReturnType<typeof githubFixture>;

async function post(path: string, payload: unknown, token = f.operator.token, key = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
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

async function connect() {
  const project = await post('/projects', {
    name: 'GitHub project',
    slug: `github-${randomUUID()}`,
  });

  const input = {
    name: 'GitHub build',
    project_id: project.json().id,
    repository: 'keel-test/application',
    workflow_id: '42',
    branch: 'main',
    artifact_name: 'application',
    token: providerToken,
    webhook_secret: webhookSecret,
  };

  const response = await post('/integrations/github', input);

  expect(response.statusCode).toBe(200);

  return { connection: response.json(), input };
}

async function enqueue(connectionId: string) {
  const response = await post(`/integrations/${connectionId}/imports`, {
    run_id: '9001',
    run_attempt: 1,
  });

  expect(response.statusCode).toBe(200);

  return response.json();
}

async function importRow(id: string) {
  return (await db.query('SELECT * FROM artifact_imports WHERE id = $1', [id])).rows[0];
}

async function webhook(
  connectionId: string,
  delivery = randomUUID(),
  payload?: string,
  secret = webhookSecret,
) {
  const body =
    payload ??
    JSON.stringify({
      action: 'completed',
      repository: github.state.repository,
      workflow_run: github.state.run,
    });

  return app.inject({
    method: 'POST',
    url: `/webhooks/github/${connectionId}`,
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': delivery,
      'x-github-event': 'workflow_run',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    payload: body,
  });
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-ingestion-'));
  control = new ControlPlane(db, new LocalArtifactStore(root));
});

beforeEach(async () => {
  await db.query(
    `
      UPDATE artifact_imports
      SET
        status = 'failed',
        lease_token = NULL,
        lease_expires_at = NULL
      WHERE
        status IN ('pending', 'processing')
    `,
  );

  f = await fixture(db);
  github = githubFixture();

  integrations = new IntegrationService(
    control,
    vault,
    (credentials) => new GitHubActionsAdapter(async () => credentials, github.transport),
  );

  worker = new ArtifactImportWorker(integrations);
  app = await createApp(control, false, integrations);
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

describe('GitHub artifact ingestion', () => {
  it('encrypts credentials, returns safe projections, and enforces permission and organisation boundaries', async () => {
    const { connection, input } = await connect();
    const row = await integrations.load(f.org, connection.id);

    expect(JSON.stringify(row.credentials)).not.toContain(providerToken);
    expect(JSON.stringify(connection)).not.toContain('credentials');
    expect((await get('/integrations')).body).not.toContain(providerToken);
    expect((await get('/integrations')).body).not.toContain(webhookSecret);
    expect((await get('/integrations')).body).not.toContain('ciphertext');
    expect((await post('/integrations/github', input, f.reader.token)).statusCode).toBe(403);

    const other = await fixture(db);

    expect(
      (
        await post(
          `/integrations/${connection.id}/imports`,
          { run_id: '9001' },
          other.operator.token,
        )
      ).statusCode,
    ).toBe(404);

    expect(
      (await get(`/integrations/${connection.id}/pipelines`, other.reader.token)).statusCode,
    ).toBe(404);

    expect((await get('/integrations', other.operator.token)).json().connections).toEqual([]);
    expect((await post('/integrations/github', input, other.operator.token)).statusCode).toBe(404);
  });

  it('retains a verified archive, copies provenance into an immutable release, and survives provider expiry', async () => {
    const { connection } = await connect();
    const job = await enqueue(connection.id);

    expect(await worker.runOnce()).toBe(true);
    const completed = await importRow(job.id);

    expect(completed.status).toBe('succeeded');

    const snapshot = (await get('/snapshot')).json();
    const artifact = snapshot.artifacts[0];

    expect(artifact.digest).toBe(sha256(github.state.bytes));

    expect(artifact.provenance).toMatchObject({
      source: 'github-actions',
      run_id: '9001',
      commit: 'a'.repeat(40),
      archive_format: 'zip',
    });

    expect(
      (
        await post('/releases', {
          project_id: connection.project_id,
          artifact_id: artifact.id,
          version: '1.0.0',
          process: deploymentProcess(),
        })
      ).json().manifest.provenance,
    ).toEqual(artifact.provenance);

    github.state.apiStatus = 410;
    const download = await get(`/artifacts/${artifact.id}/download`);

    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(github.state.bytes);
    expect((await enqueue(connection.id)).id).toBe(job.id);
    expect(await worker.runOnce()).toBe(false);
    expect((await get('/snapshot')).json().artifacts).toHaveLength(1);

    const archiveCall = github.state.calls.find((call) =>
      call.url.includes('blob.core.windows.net'),
    )!;

    expect(new Headers(archiveCall.init?.headers).has('authorization')).toBe(false);
    expect(archiveCall.init?.redirect).toBe('error');
  });

  it('verifies exact webhook bytes and deduplicates redelivery and concurrent run requests', async () => {
    const { connection } = await connect();
    const delivery = randomUUID();

    expect((await webhook(connection.id, delivery, undefined, 'wrong-secret')).statusCode).toBe(
      401,
    );

    const deliveries = await Promise.all([
      webhook(connection.id, delivery),
      webhook(connection.id, delivery),
      webhook(connection.id),
    ]);

    expect(deliveries.map((response) => response.statusCode)).toEqual([202, 202, 202]);
    expect(deliveries.filter((response) => response.json().duplicate)).toHaveLength(1);
    expect((await get('/integrations')).json().imports).toHaveLength(1);

    const changed = JSON.stringify({
      action: 'requested',
      repository: github.state.repository,
      workflow_run: github.state.run,
    });

    expect((await webhook(connection.id, delivery, changed)).statusCode).toBe(409);

    expect(
      (
        await db.query(
          'SELECT count(*) FROM provider_webhook_deliveries WHERE connection_id = $1',
          [connection.id],
        )
      ).rows[0].count,
    ).toBe('2');

    expect((await Promise.all([worker.runOnce(), worker.runOnce()])).sort()).toEqual([false, true]);
    expect((await get('/snapshot')).json().artifacts).toHaveLength(1);
  });

  it.each([
    [
      'failed workflow',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.run.conclusion = 'failure';
      },
      'RUN_NOT_SUCCESSFUL',
    ],
    [
      'fork run',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.run.head_repository.id = 456;
      },
      'RUN_NOT_TRUSTED',
    ],
    [
      'pull request event',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.run.event = 'pull_request_target';
      },
      'RUN_NOT_TRUSTED',
    ],
    [
      'different branch',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.run.head_branch = 'untrusted';
      },
      'RUN_NOT_TRUSTED',
    ],
    [
      'different workflow',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.run.workflow_id = 43;
      },
      'RUN_NOT_TRUSTED',
    ],
    [
      'new run attempt',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.run.run_attempt = 2;
      },
      'RUN_ATTEMPT_CHANGED',
    ],
    [
      'missing checksum',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.artifacts[0].digest = '';
      },
      'ARTIFACT_DIGEST_REQUIRED',
    ],
    [
      'tampered download',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.bytes = Buffer.from('tampered');
      },
      'DIGEST_MISMATCH',
    ],
    [
      'expired artifact',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.artifacts[0].expired = true;
      },
      'ARTIFACT_EXPIRED',
    ],
    [
      'artifact substitution',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.artifacts[0].workflow_run.head_sha = 'b'.repeat(40);
      },
      'ARTIFACT_RUN_MISMATCH',
    ],
    [
      'unsafe redirect',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.redirect = 'http://169.254.169.254/latest/meta-data';
      },
      'PROVIDER_REDIRECT_REJECTED',
    ],
    [
      'ambiguous name',
      (state: ReturnType<typeof githubFixture>['state']) => {
        state.artifacts.push({ ...state.artifacts[0], id: 8002 });
      },
      'ARTIFACT_SELECTION_FAILED',
    ],
  ])('rejects %s without publishing an artifact', async (_label, change, code) => {
    const { connection } = await connect();
    const job = await enqueue(connection.id);

    change(github.state);
    await worker.runOnce();

    expect(await importRow(job.id)).toMatchObject({ status: 'failed', error_code: code });
    expect((await get('/snapshot')).json().artifacts).toEqual([]);
  });

  it('persists backoff for rate limits, bounds attempts, and allows an explicit retry after credential rotation', async () => {
    const { connection } = await connect();
    const job = await enqueue(connection.id);

    github.state.apiStatus = 429;
    github.state.retryAfter = '60';
    await worker.runOnce();
    const delayed = await importRow(job.id);

    expect(delayed).toMatchObject({
      status: 'pending',
      attempts: 1,
      error_code: 'PROVIDER_RATE_LIMIT',
    });

    expect(new Date(delayed.available_at).getTime()).toBeGreaterThan(Date.now() + 55000);
    expect(await worker.runOnce()).toBe(false);

    await db.query(
      `
        UPDATE artifact_imports
        SET
          attempts = 4,
          available_at = now()
        WHERE
          id = $1
      `,
      [job.id],
    );

    await worker.runOnce();
    expect(await importRow(job.id)).toMatchObject({ status: 'failed', attempts: 5 });

    github.state.apiStatus = 200;
    const rotatedSecret = 'new-webhook-secret-with-at-least-32-characters';

    expect(
      (
        await post(`/integrations/${connection.id}/credentials`, {
          token: 'new-provider-test-token',
          webhook_secret: rotatedSecret,
        })
      ).statusCode,
    ).toBe(200);

    expect((await webhook(connection.id)).statusCode).toBe(401);

    expect((await webhook(connection.id, randomUUID(), undefined, rotatedSecret)).statusCode).toBe(
      202,
    );

    expect((await post(`/imports/${job.id}/retry`, {})).statusCode).toBe(200);
    await worker.runOnce();
    expect(await importRow(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('fences a worker whose lease was reclaimed after a crash', async () => {
    const { connection } = await connect();
    const job = await enqueue(connection.id);
    let releaseDownload!: () => void;
    let notifyDownload!: () => void;

    const started = new Promise<void>((resolve) => {
      notifyDownload = resolve;
    });

    const resume = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });

    github.state.beforeDownload = async () => {
      github.state.beforeDownload = undefined;
      notifyDownload();
      await resume;
    };

    const staleWorker = worker.runOnce();

    await started;

    await db.query(
      `
        UPDATE artifact_imports
        SET
          lease_expires_at = now() - interval '1 second'
        WHERE
          id = $1
      `,
      [job.id],
    );

    await new ArtifactImportWorker(integrations).runOnce();
    releaseDownload();
    await staleWorker;

    expect(await importRow(job.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect((await get('/snapshot')).json().artifacts).toHaveLength(1);

    expect(
      (await get('/snapshot'))
        .json()
        .audit.filter((event: { action: string }) => event.action === 'artifact.imported'),
    ).toHaveLength(1);
  });

  it('prevents an in-flight import from publishing after the connection is disabled', async () => {
    const { connection } = await connect();
    const job = await enqueue(connection.id);

    github.state.beforeDownload = async () => {
      expect(
        (await post(`/integrations/${connection.id}/state`, { enabled: false })).statusCode,
      ).toBe(200);
    };

    await worker.runOnce();
    expect((await get('/snapshot')).json().artifacts).toEqual([]);
    expect((await webhook(connection.id)).statusCode).toBe(401);

    expect(
      (await post(`/integrations/${connection.id}/imports`, { run_id: '9001' })).statusCode,
    ).toBe(409);

    expect(await importRow(job.id)).toMatchObject({
      status: 'pending',
      error_code: 'CONNECTION_CHANGED',
    });
  });

  it('fails closed when credential encryption has not been configured', async () => {
    const unconfigured = await createApp(control);

    try {
      const response = await unconfigured.inject({
        method: 'POST',
        url: '/api/v1/integrations/github',
        headers: { authorization: `Bearer ${f.operator.token}`, 'idempotency-key': randomUUID() },
        payload: {
          name: 'Build',
          project_id: randomUUID(),
          repository: 'keel-test/application',
          workflow_id: '42',
          branch: 'main',
          artifact_name: 'application',
          token: providerToken,
          webhook_secret: webhookSecret,
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('CREDENTIAL_KEY_REQUIRED');
    } finally {
      await unconfigured.close();
    }
  });
});
