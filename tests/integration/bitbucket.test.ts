import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import { S3ArtifactStore } from '../../apps/api/src/s3-artifact-store.js';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../apps/api/src/app.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { IntegrationService } from '../../apps/api/src/integration-service.js';
import { ArtifactImportWorker } from '../../apps/api/src/artifact-import-worker.js';
import { BitbucketPipelinesAdapter } from '../../packages/integrations/src/bitbucket-pipelines.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { deploymentProcess, fixture, testDatabaseUrl } from '../fixtures.js';
import { bitbucketFixture } from '../bitbucket-fixture.js';

const schema = `bitbucket_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const vault = new CredentialVault(randomBytes(32).toString('base64'));
const providerToken = 'bitbucket-test-repository-access-token';
const publishSecret = 'bitbucket-test-publish-secret-32-characters';
let app: FastifyInstance;
let root: string;
let control: ControlPlane;
let integrations: IntegrationService;
let worker: ArtifactImportWorker;
let f: Awaited<ReturnType<typeof fixture>>;
let bitbucket: ReturnType<typeof bitbucketFixture>;

async function post(path: string, payload: unknown, token = f.operator.token) {
  return app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
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
    name: 'Bitbucket project',
    slug: `bb-${randomUUID()}`,
  });

  const input = {
    name: 'Bitbucket build',
    project_id: project.json().id,
    repository: 'keel-test/application',
    workflow_id: 'branches:main',
    branch: 'main',
    artifact_name: 'application',
    token: providerToken,
    publish_secret: publishSecret,
  };

  const response = await post('/integrations/bitbucket', input);

  expect(response.statusCode).toBe(200);

  return { connection: response.json(), input };
}

async function publish(
  id: string,
  secret = publishSecret,
  bytes = bitbucket.state.bytes,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/publish/bitbucket/${id}`,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/octet-stream',
      'x-bitbucket-pipeline': bitbucket.state.run.uuid,
      'x-bitbucket-step': bitbucket.state.step.uuid,
      'x-bitbucket-commit': bitbucket.state.run.target.commit.hash,
      'x-artifact-sha256': sha256(bytes),
      ...headers,
    },
    payload: bytes,
  });
}

async function importRow(id: string) {
  return (await db.query('SELECT * FROM artifact_imports WHERE id = $1', [id])).rows[0];
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-bitbucket-'));
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
  bitbucket = bitbucketFixture();

  integrations = new IntegrationService(
    control,
    vault,
    undefined,
    (credentials) => new BitbucketPipelinesAdapter(credentials, bitbucket.transport),
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

describe('Bitbucket pipeline publishing', () => {
  it('encrypts secrets, scopes administration, and advertises honest provider capabilities', async () => {
    const { connection, input } = await connect();
    const row = await integrations.load(f.org, connection.id);

    expect(JSON.stringify(row.credentials)).not.toContain(providerToken);
    expect(JSON.stringify(row.credentials)).not.toContain(publishSecret);

    expect((await get('/integrations')).body).not.toMatch(
      /ciphertext|publish_secret|bitbucket-test-repository-access-token/,
    );

    expect((await post('/integrations/bitbucket', input, f.reader.token)).statusCode).toBe(403);
    const other = await fixture(db);

    expect((await post('/integrations/bitbucket', input, other.operator.token)).statusCode).toBe(
      404,
    );

    expect(
      (await post(`/integrations/${connection.id}/state`, { enabled: false }, other.operator.token))
        .statusCode,
    ).toBe(404);

    expect((await get('/integrations', other.operator.token)).json().connections).toEqual([]);

    expect((await get(`/integrations/${connection.id}/pipelines`)).json().error.code).toBe(
      'UNSUPPORTED_OPERATION',
    );

    expect(
      (await post(`/integrations/${connection.id}/imports`, { run_id: '1' })).json().error.code,
    ).toBe('UNSUPPORTED_OPERATION');

    const provider = (await get('/providers'))
      .json()
      .providers.find((entry: { id: string }) => entry.id === 'bitbucket-pipelines');

    expect(provider).toMatchObject({
      available: true,
      capabilities: {
        artifactIngestion: 'publishing-step',
        getRun: true,
        listPipelines: false,
        listArtifacts: false,
        deployment: false,
      },
    });

    expect((await get('/snapshot', publishSecret)).statusCode).toBe(401);
  });

  it('keeps uploaded bytes out of releases until the complete pipeline succeeds, then retains provenance', async () => {
    const { connection } = await connect();
    const uploaded = await publish(connection.id);

    expect(uploaded.statusCode).toBe(202);
    expect((await get('/snapshot')).json().artifacts).toEqual([]);
    await worker.runOnce();
    const waiting = await importRow(uploaded.json().id);

    expect(waiting).toMatchObject({
      status: 'pending',
      attempts: 0,
      error_code: 'RUN_AWAITING_COMPLETION',
      artifact_id: null,
    });

    expect(new Date(waiting.available_at).getTime()).toBeGreaterThan(Date.now());
    expect((await get('/snapshot')).json().artifacts).toEqual([]);
    bitbucket.succeed();
    await db.query('UPDATE artifact_imports SET available_at = now() WHERE id = $1', [waiting.id]);
    await worker.runOnce();
    const completed = await importRow(waiting.id);

    expect(completed.status).toBe('succeeded');
    const artifact = (await get('/snapshot')).json().artifacts[0];

    expect(artifact.digest).toBe(sha256(bitbucket.state.bytes));

    expect(artifact.provenance).toMatchObject({
      source: 'bitbucket-pipelines',
      run_id: bitbucket.state.run.uuid,
      step_id: bitbucket.state.step.uuid,
      commit: 'b'.repeat(40),
      digest_source: 'authenticated-publisher',
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

    bitbucket.state.apiStatus = 410;

    expect((await get(`/artifacts/${artifact.id}/download`)).rawPayload).toEqual(
      bitbucket.state.bytes,
    );

    const other = await fixture(db);

    expect((await get(`/artifacts/${artifact.id}/download`, other.reader.token)).statusCode).toBe(
      404,
    );
  });

  it('deduplicates concurrent deliveries and refuses to substitute a different artifact or step', async () => {
    const { connection } = await connect();

    const uploads = await Promise.all([
      publish(connection.id),
      publish(connection.id),
      publish(connection.id),
    ]);

    expect(uploads.map((response) => response.statusCode)).toEqual([202, 202, 202]);
    expect(new Set(uploads.map((response) => response.json().id)).size).toBe(1);
    expect(uploads.filter((response) => !response.json().duplicate)).toHaveLength(1);

    expect(
      (await publish(connection.id, publishSecret, Buffer.from('substitution'))).json().error.code,
    ).toBe('PUBLISH_CONFLICT');

    expect(
      (
        await publish(connection.id, publishSecret, undefined, {
          'x-bitbucket-step': `{${randomUUID()}}`,
        })
      ).json().error.code,
    ).toBe('PUBLISH_CONFLICT');

    bitbucket.succeed();
    await worker.runOnce();

    expect((await publish(connection.id)).json()).toMatchObject({
      duplicate: true,
      status: 'succeeded',
    });

    expect((await get('/snapshot')).json().artifacts).toHaveLength(1);

    await expect(
      db.query('UPDATE artifact_imports SET candidate_digest = $2 WHERE id = $1', [
        uploads[0].json().id,
        'a'.repeat(64),
      ]),
    ).rejects.toThrow('Import source is immutable');
  });

  it.each([
    'failed',
    'stopped',
    'step-failed',
    'changed-commit',
    'pull-request',
    'wrong-branch',
    'wrong-selector',
    'wrong-repository',
  ])('rejects %s after upload without exposing an artifact', async (scenario) => {
    const { connection } = await connect();
    const job = (await publish(connection.id)).json();

    bitbucket.succeed();

    if (scenario === 'failed') {
      bitbucket.state.run.state.result = { name: 'FAILED' };
    }

    if (scenario === 'stopped') {
      bitbucket.state.run.state.result = { name: 'STOPPED' };
    }

    if (scenario === 'step-failed') {
      bitbucket.state.step.state.result = { name: 'FAILED' };
    }

    if (scenario === 'changed-commit') {
      bitbucket.state.run.target.commit.hash = 'c'.repeat(40);
    }

    if (scenario === 'pull-request') {
      bitbucket.state.run.target.type = 'pipeline_pullrequest_target';
    }

    if (scenario === 'wrong-branch') {
      bitbucket.state.run.target.ref_name = 'feature';
    }

    if (scenario === 'wrong-selector') {
      bitbucket.state.run.target.selector.pattern = 'release';
    }

    if (scenario === 'wrong-repository') {
      bitbucket.state.run.repository.uuid = `{${randomUUID()}}`;
    }

    await worker.runOnce();
    expect((await importRow(job.id)).status).toBe('failed');
    expect((await get('/snapshot')).json().artifacts).toEqual([]);
  });

  it('rejects incorrect publisher credentials, malformed IDs, digest mismatches and post-completion uploads', async () => {
    const { connection } = await connect();

    expect(
      (await publish(connection.id, 'wrong-secret-with-at-least-32-characters')).statusCode,
    ).toBe(401);

    expect((await publish(connection.id, f.operator.token)).statusCode).toBe(401);

    expect(
      (
        await publish(connection.id, publishSecret, undefined, {
          'x-bitbucket-pipeline': '../../secrets',
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await publish(connection.id, publishSecret, undefined, {
          'x-artifact-sha256': 'c'.repeat(64),
        })
      ).json().error.code,
    ).toBe('DIGEST_MISMATCH');

    expect((await publish(connection.id, publishSecret, Buffer.alloc(0))).statusCode).toBe(400);
    bitbucket.state.run.target.ref_name = 'feature';
    expect((await publish(connection.id)).json().error.code).toBe('RUN_NOT_TRUSTED');
    bitbucket.state.run.target.ref_name = 'main';
    bitbucket.succeed();
    expect((await publish(connection.id)).json().error.code).toBe('PUBLISH_STEP_NOT_RUNNING');
    expect((await get('/integrations')).json().imports).toEqual([]);
  });

  it('invalidates old publishing credentials on rotation and blocks disabled connections', async () => {
    const { connection } = await connect();
    const rotated = `${publishSecret}-rotated`;

    expect(
      (
        await post(`/integrations/${connection.id}/bitbucket-credentials`, {
          token: `${providerToken}-rotated`,
          publish_secret: rotated,
        })
      ).statusCode,
    ).toBe(200);

    expect((await publish(connection.id)).statusCode).toBe(401);
    const job = (await publish(connection.id, rotated)).json();

    expect(job.id).toBeTruthy();
    await post(`/integrations/${connection.id}/state`, { enabled: false });
    expect((await publish(connection.id, rotated)).statusCode).toBe(401);
    bitbucket.succeed();
    await worker.runOnce();
    expect((await importRow(job.id)).error_code).toBe('CONNECTION_DISABLED');
    expect((await get('/snapshot')).json().artifacts).toEqual([]);
    await post(`/integrations/${connection.id}/state`, { enabled: true });
    await post(`/imports/${job.id}/retry`, {});
    await worker.runOnce();
    expect((await importRow(job.id)).status).toBe('succeeded');
  });

  it('persists rate-limit retries and detects corruption in quarantined bytes', async () => {
    const { connection } = await connect();
    const job = (await publish(connection.id)).json();

    bitbucket.state.apiStatus = 429;
    await worker.runOnce();
    const pending = await importRow(job.id);

    expect(pending).toMatchObject({
      status: 'pending',
      attempts: 1,
      error_code: 'PROVIDER_RATE_LIMIT',
    });

    expect(new Date(pending.available_at).getTime()).toBeGreaterThan(Date.now() + 40000);
    bitbucket.state.apiStatus = 200;
    bitbucket.succeed();
    await writeFile(join(root, f.org, sha256(bitbucket.state.bytes)), 'corrupt');
    await db.query('UPDATE artifact_imports SET available_at = now() WHERE id = $1', [job.id]);
    await worker.runOnce();
    expect((await importRow(job.id)).error_code).toBe('ARTIFACT_CORRUPT');
    expect((await get('/snapshot')).json().artifacts).toEqual([]);
    await writeFile(join(root, f.org, sha256(bitbucket.state.bytes)), bitbucket.state.bytes);
  });

  it('expires incomplete pipelines after 24 hours instead of polling forever', async () => {
    const { connection } = await connect();
    const job = (await publish(connection.id)).json();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);

    try {
      await worker.runOnce();
    } finally {
      clock.mockRestore();
    }

    expect(await importRow(job.id)).toMatchObject({
      status: 'failed',
      error_code: 'RUN_WAIT_EXPIRED',
    });

    expect((await get('/snapshot')).json().artifacts).toEqual([]);
  });

  it('fences an expired worker when another worker reclaims and completes the submission', async () => {
    const { connection } = await connect();
    const job = (await publish(connection.id)).json();
    let runReads = 0;

    bitbucket.succeed();

    bitbucket.state.beforeResponse = async (url) => {
      if (url.includes('/steps/')) {
        return;
      }

      runReads++;

      if (runReads === 2) {
        await db.query(
          "UPDATE artifact_imports SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
          [job.id],
        );

        await new ArtifactImportWorker(integrations).runOnce();
      }
    };

    await worker.runOnce();
    expect(await importRow(job.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect((await get('/snapshot')).json().artifacts).toHaveLength(1);

    const audits = await db.query(
      "SELECT 1 FROM audit_events WHERE organisation_id = $1 AND action = 'artifact.imported'",
      [f.org],
    );

    expect(audits.rowCount).toBe(1);
  });

  it('rejects a connection revision changed while the worker verifies the pipeline', async () => {
    const { connection } = await connect();
    const job = (await publish(connection.id)).json();
    let runReads = 0;

    bitbucket.succeed();

    bitbucket.state.beforeResponse = async (url) => {
      if (url.includes('/steps/')) {
        return;
      }

      if (++runReads === 2) {
        await post(`/integrations/${connection.id}/state`, { enabled: false });
      }
    };

    await worker.runOnce();

    expect(await importRow(job.id)).toMatchObject({
      status: 'pending',
      error_code: 'CONNECTION_CHANGED',
    });

    expect((await get('/snapshot')).json().artifacts).toEqual([]);
  });

  it.skipIf(!process.env.TEST_S3_ENDPOINT)(
    'copies pending submission blobs when moving local storage to S3',
    async () => {
      const { connection } = await connect();
      const job = (await publish(connection.id)).json();
      const bucket = `keel-copy-test-${randomUUID()}`;
      const endpoint = process.env.TEST_S3_ENDPOINT;

      const client = new S3Client({
        endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: 'keel-local', secretAccessKey: 'keel-local-storage-only' },
      });

      await client.send(new CreateBucketCommand({ Bucket: bucket }));

      try {
        const databaseUrl = new URL(testDatabaseUrl);

        databaseUrl.searchParams.set('options', `-c search_path=${schema}`);

        const copied = await promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'scripts/copy-artifacts-to-s3.ts'],
          {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl.toString(),
              ARTIFACT_PATH: root,
              ARTIFACT_STORE: 's3',
              S3_ENDPOINT: endpoint,
              S3_BUCKET: bucket,
              S3_FORCE_PATH_STYLE: 'true',
              AWS_REGION: 'us-east-1',
              AWS_ACCESS_KEY_ID: 'keel-local',
              AWS_SECRET_ACCESS_KEY: 'keel-local-storage-only',
            },
          },
        );

        expect(copied.stdout).toMatch(/Verified \d+ retained blobs in S3/);

        expect(
          await new S3ArtifactStore(client, bucket).get(f.org, sha256(bitbucket.state.bytes)),
        ).toEqual(bitbucket.state.bytes);

        expect((await importRow(job.id)).status).toBe('pending');
        expect((await get('/snapshot')).json().artifacts).toEqual([]);
      } finally {
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));

        if (objects.Contents?.length) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
            }),
          );
        }

        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
      }
    },
  );

  it('runs the standalone pipeline publisher and CLI with only the connection publishing secret', async () => {
    const { connection } = await connect();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const file = join(root, 'build.tar.gz');

    await writeFile(file, bitbucket.state.bytes);

    const env = {
      ...process.env,
      KEEL_URL: address,
      KEEL_CONNECTION_ID: connection.id,
      KEEL_PUBLISH_SECRET: publishSecret,
      KEEL_TOKEN: '',
      BITBUCKET_PIPELINE_UUID: bitbucket.state.run.uuid,
      BITBUCKET_STEP_UUID: bitbucket.state.step.uuid,
      BITBUCKET_COMMIT: bitbucket.state.run.target.commit.hash,
    };

    const first = await promisify(execFile)(
      process.execPath,
      ['scripts/publish-bitbucket.mjs', file],
      { env },
    );

    expect(JSON.parse(first.stdout)).toMatchObject({ status: 'pending', duplicate: false });

    const second = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/cli/src/main.ts',
        'artifact',
        'publish-bitbucket',
        file,
        '--connection',
        connection.id,
      ],
      { env },
    );

    expect(JSON.parse(second.stdout)).toMatchObject({ duplicate: true });

    expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(
      publishSecret,
    );
  });
});
