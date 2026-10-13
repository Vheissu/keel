import { authenticatorCode } from '../../tests/authenticator.js';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { initialize, compose, type Installation } from './installation.js';
import { up, stop, status } from './lifecycle.js';
import { backup, restore, validateBackup } from './backup.js';
import { sha256 } from '../../apps/api/src/artifact-store.js';
import { deploymentProcess } from '../../tests/fixtures.js';

const id = randomUUID().slice(0, 8);
const root = resolve('.data', `self-host-drill-${id}`);
const original = join(root, 'original');
const recovered = join(root, 'recovered');
const restoredProject = `keel-recovered-${id}`;
let installation: Installation;
let token: string;
let ca: Buffer;

async function port() {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return value;
}

async function http(
  path: string,
  body?: unknown,
  credential = token,
  gateway = false,
  headers: Record<string, string> = {},
) {
  let bytes: Buffer | undefined;

  if (body !== undefined) {
    bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  }

  const identity = gateway
    ? {
        cert: await readFile(join(original, 'tls/agent.crt')),
        key: await readFile(join(original, 'tls/agent.key')),
      }
    : {};

  return new Promise<{
    status: number;
    bytes: Buffer;
    headers: IncomingHttpHeaders;
    json: () => any;
  }>((resolve, reject) => {
    const req = request(
      `https://localhost:${gateway ? installation.agentPort : installation.httpsPort}${path}`,
      {
        ca,
        ...identity,
        method: bytes ? 'POST' : 'GET',
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...headers,
          'idempotency-key': randomUUID(),
          ...(bytes
            ? {
                'content-type': Buffer.isBuffer(body)
                  ? 'application/octet-stream'
                  : 'application/json',
                'content-length': bytes.length,
              }
            : {}),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          const bytes = Buffer.concat(chunks);

          resolve({
            status: res.statusCode!,
            bytes,
            headers: res.headers,
            json: () => JSON.parse(bytes.toString()),
          });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP timed out.')));
    req.end(bytes);
  });
}

async function api(path: string, body?: unknown, credential = token) {
  const result = await http(`/api/v1${path}`, body, credential);

  assert.equal(result.status, 200, `Unexpected API status for ${path}: ${result.bytes.toString()}`);

  return result.json();
}

async function until(check: () => Promise<boolean>, timeout = 90000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Timed out waiting for packaged service recovery.');
}

// The reserved .invalid domain exercises durable network failure without a live receiver.
process.env.KEEL_NOTIFICATION_ORIGINS = 'https://notifications.invalid';

await mkdir(root, { recursive: true, mode: 0o700 });

try {
  installation = {
    format: 1,
    project: `keel-drill-${id}`,
    hostname: 'localhost',
    bind: '127.0.0.1',
    httpsPort: await port(),
    agentPort: await port(),
    imageTag: process.env.KEEL_TEST_IMAGE || `drill-${id}`,
  };

  await initialize(original, installation);

  if (!process.env.KEEL_TEST_IMAGE) {
    console.log('Building the packaged application.');
    await compose(original, installation, ['build', 'api']);
  }

  console.log('Starting the isolated installation.');
  await up(original, installation);
  await status(original, installation);
  token = (await readFile(join(original, 'secrets/operator_token'), 'utf8')).trim();
  ca = await readFile(join(original, 'tls/ca.crt'));
  assert.equal((await http('/')).status, 200);
  assert.equal((await http('/health')).status, 200);
  const snapshot = await api('/snapshot');
  const staging = snapshot.environments.find((row: { slug: string }) => row.slug === 'staging');

  const project = await api('/projects', {
    name: 'Recovery drill',
    slug: 'recovery',
    description: '',
  });

  const bytes = Buffer.from(`Retained artifact ${id}`);

  const artifact = await api(
    `/artifacts?project_id=${project.id}&name=application&version=1&digest=${sha256(bytes)}`,
    bytes,
  );

  const secretManager = (
    await readFile(join(original, 'secrets/secret_manager_token'), 'utf8')
  ).trim();

  await api(
    '/secrets',
    {
      project_id: project.id,
      environment_id: staging.id,
      name: 'PASSWORD',
      value: randomBytes(32).toString('hex'),
    },
    secretManager,
  );

  const release = await api('/releases', {
    project_id: project.id,
    artifact_id: artifact.id,
    version: '1',
    process: deploymentProcess(),
  });

  const destination = await api('/notifications/endpoints', {
    name: 'Recovery alerts',
    url: 'https://notifications.invalid/keel',
    signing_secret: randomBytes(32).toString('hex'),
    statuses: ['queued', 'failed'],
  });

  // Keep work queued to prove the backup barrier fails and admission resumes.
  await compose(original, installation, ['stop', 'workflow-worker']);

  const deployment = await api('/deployments', {
    release_id: release.id,
    environment_id: staging.id,
  });

  await assert.rejects(stop(original, installation), /prevents a clean stop/);
  await until(async () => (await http('/health').catch(() => null))?.status === 200);
  await compose(original, installation, ['start', 'workflow-worker']);

  await until(
    async () =>
      (await api('/snapshot')).deployments.find((row: { id: string }) => row.id === deployment.id)
        ?.status === 'failed',
  );

  await until(async () =>
    (await api('/resources/notification-deliveries')).items.some(
      (row: { attempt_count: number; last_code: string }) =>
        row.attempt_count > 0 && row.last_code === 'NETWORK_ERROR',
    ),
  );

  const beforeRestart = await api('/snapshot');

  assert.equal(beforeRestart.deployments[0].result_code, 'UNSUPPORTED_PROCESS');
  console.log('Restarting PostgreSQL, Temporal and application services.');

  await compose(original, installation, [
    'restart',
    'postgres',
    'temporal',
    'api',
    'artifact-worker',
    'notification-worker',
    'workflow-worker',
    'agent-gateway',
  ]);

  await until(async () => {
    try {
      await status(original, installation);

      return true;
    } catch {
      return false;
    }
  });

  assert.deepEqual((await api('/snapshot')).deployments, beforeRestart.deployments);

  const agent = await api('/agents', {
    name: 'Recovery agent',
    certificate_fingerprint: new X509Certificate(
      await readFile(join(original, 'tls/agent.crt')),
    ).fingerprint256
      .replaceAll(':', '')
      .toLowerCase(),
  });

  await api('/targets', {
    project_id: project.id,
    environment_id: staging.id,
    agent_id: agent.id,
    name: 'Recovery target',
    labels: { tier: 'staging' },
  });

  assert.equal((await http('/agent/v1/poll', {}, token, true)).status, 200);

  const permissions = await compose(original, installation, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'keel',
    '-Atc',
    "SELECT has_schema_privilege('keel_runtime','public','CREATE'), has_database_privilege('keel_runtime','temporal','CONNECT'), rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='keel_runtime'",
  ]);

  assert.equal(permissions.trim(), 'f|f|f|f|f');

  await assert.rejects(
    compose(original, installation, [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'keel',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SET ROLE keel_runtime; CREATE TABLE forbidden(id int)',
    ]),
    /permission denied/,
  );

  const verified = JSON.parse(
    await compose(original, installation, ['run', '--rm', '--no-deps', 'operations', 'verify']),
  );

  assert.equal(verified.artifacts, 1);
  assert.equal(verified.secret_versions, 1);
  assert.equal(verified.notification_endpoints, 1);

  console.log(
    'Enabling hosted identity and provisioning a workspace owner through packaged operations.',
  );

  installation.publicUrl = `https://localhost:${installation.httpsPort}`;

  await writeFile(join(original, 'installation.json'), JSON.stringify(installation, null, 2), {
    mode: 0o600,
  });

  await compose(original, installation, ['up', '-d', '--wait', 'api']);
  assert.equal((await http('/api/v1/snapshot')).status, 401);
  const ownerEmail = 'owner@example.com';
  const ownerPassword = randomBytes(32).toString('base64url');

  const ownerInvite = JSON.parse(
    await compose(original, installation, [
      'run',
      '--rm',
      '--no-deps',
      'operations',
      'identity',
      'invite-owner',
      snapshot.organisation.id,
      ownerEmail,
    ]),
  );

  const accepted = await http(
    '/api/auth/accept',
    {
      token: new URL(ownerInvite.link).hash.split('token=')[1],
      name: 'Recovery owner',
      password: ownerPassword,
    },
    '',
    false,
    { origin: installation.publicUrl },
  );

  assert.equal(accepted.status, 200);
  let cookie = accepted.headers['set-cookie']![0].split(';')[0];

  assert.ok(accepted.headers['set-cookie']![0].includes('Secure'));
  const session = await http('/api/auth/session', undefined, '', false, { cookie });

  const sessionHeaders = {
    cookie,
    origin: installation.publicUrl,
    'x-csrf-token': session.json().csrf,
    'x-workspace-id': snapshot.organisation.id,
  };

  const enrollment = await http(
    '/api/auth/mfa/enroll',
    { current_password: ownerPassword },
    '',
    false,
    sessionHeaders,
  );

  assert.equal(enrollment.status, 200);
  const setupKey = enrollment.json().secret;

  const confirmation = await http(
    '/api/auth/mfa/confirm',
    { code: authenticatorCode(setupKey, -1) },
    '',
    false,
    sessionHeaders,
  );

  assert.equal(confirmation.status, 200);
  cookie = confirmation.headers['set-cookie']![0].split(';')[0];
  sessionHeaders.cookie = cookie;
  sessionHeaders['x-csrf-token'] = confirmation.json().csrf;
  const oldRecoveryCode = confirmation.json().recovery_codes[0];

  const mfaVerification = JSON.parse(
    await compose(original, installation, ['run', '--rm', '--no-deps', 'operations', 'verify']),
  );

  assert.equal(mfaVerification.mfa_accounts, 1);

  const managed = await http(
    '/api/v1/identity/tokens',
    { name: 'Recovery drill', permissions: ['read', 'write'], expires_in_days: 1 },
    '',
    false,
    sessionHeaders,
  );

  assert.equal(managed.status, 200);
  token = managed.json().token;
  assert.equal((await api('/snapshot')).organisation.id, snapshot.organisation.id);

  const pending = await http(
    '/api/v1/identity/invitations',
    { email: 'pending@example.com', role: 'reader' },
    '',
    false,
    sessionHeaders,
  );

  assert.equal(pending.status, 200);
  const pendingToken = new URL(pending.json().link).hash.split('token=')[1];

  const recovery = JSON.parse(
    await compose(original, installation, [
      'run',
      '--rm',
      '--no-deps',
      'operations',
      'identity',
      'reset-password',
      ownerEmail,
    ]),
  );

  const recoveryToken = new URL(recovery.link).hash.split('token=')[1];

  console.log('Backing up and testing wrong-key and corruption rejection.');
  await stop(original, installation);
  const key = randomBytes(32);
  const keyFile = join(root, 'backup.key');
  const saved = join(root, 'backup');

  await writeFile(keyFile, key.toString('base64'), { mode: 0o600 });
  await backup(original, installation, saved, keyFile);
  await validateBackup(saved, key);
  await assert.rejects(validateBackup(saved, randomBytes(32)));
  const corrupt = join(root, 'corrupt');

  await cp(saved, corrupt, { recursive: true });
  const damaged = await readFile(join(corrupt, 'artifacts.enc'));

  damaged[24] ^= 1;
  await writeFile(join(corrupt, 'artifacts.enc'), damaged);
  await assert.rejects(restore(corrupt, recovered, keyFile, restoredProject), /checksum failed/);
  await assert.rejects(readFile(join(recovered, 'installation.json')), { code: 'ENOENT' });
  console.log('Restoring into fresh volumes and verifying agent quarantine.');
  await restore(saved, recovered, keyFile, restoredProject);
  const restored = { ...installation, project: restoredProject };

  await up(recovered, restored);
  await status(recovered, restored);

  assert.equal(restored.publicUrl, installation.publicUrl);
  assert.equal((await http('/api/v1/snapshot')).status, 401);

  assert.equal(
    (await http('/api/auth/session', undefined, '', false, { cookie })).json().user,
    null,
  );

  assert.equal(
    (
      await http('/api/auth/invitation', { token: pendingToken }, '', false, {
        origin: installation.publicUrl,
      })
    ).status,
    400,
  );

  assert.equal(
    (
      await http(
        '/api/auth/reset-password',
        { token: recoveryToken, password: ownerPassword },
        '',
        false,
        { origin: installation.publicUrl },
      )
    ).status,
    400,
  );

  const login = await http(
    '/api/auth/login',
    { email: ownerEmail, password: ownerPassword },
    '',
    false,
    { origin: installation.publicUrl },
  );

  assert.equal(login.status, 200);
  assert.equal(login.json().mfa_required, true);
  assert.equal(login.headers['set-cookie'], undefined);

  const oldCode = await http(
    '/api/auth/mfa/challenge',
    { challenge: login.json().challenge, code: oldRecoveryCode },
    '',
    false,
    { origin: installation.publicUrl },
  );

  assert.equal(oldCode.status, 403);

  const verifiedLogin = await http(
    '/api/auth/mfa/challenge',
    { challenge: login.json().challenge, code: authenticatorCode(setupKey) },
    '',
    false,
    { origin: installation.publicUrl },
  );

  assert.equal(verifiedLogin.status, 200);
  const nextCookie = verifiedLogin.headers['set-cookie']![0].split(';')[0];
  const nextSession = await http('/api/auth/session', undefined, '', false, { cookie: nextCookie });

  const replacement = await http(
    '/api/v1/identity/tokens',
    { name: 'After restore', permissions: ['read', 'write'], expires_in_days: 1 },
    '',
    false,
    {
      cookie: nextCookie,
      origin: installation.publicUrl,
      'x-csrf-token': nextSession.json().csrf,
      'x-workspace-id': snapshot.organisation.id,
    },
  );

  assert.equal(replacement.status, 200);
  token = replacement.json().token;

  const history = JSON.parse(
    await compose(recovered, restored, [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'temporal',
      'temporal-namespace',
      'workflow',
      'describe',
      '--namespace',
      'keel',
      '--workflow-id',
      `deployment-${deployment.id}`,
      '--output',
      'json',
    ]),
  );

  assert.equal(history.workflowExecutionInfo.status, 'WORKFLOW_EXECUTION_STATUS_COMPLETED');
  assert.deepEqual((await http(`/api/v1/artifacts/${artifact.id}/download`)).bytes, bytes);
  const restoredDestination = await api(`/resources/notification-endpoints/${destination.id}`);

  assert.equal(restoredDestination.enabled, false);
  const restoredNotifications = await api('/resources/notification-deliveries');

  assert.equal(restoredNotifications.total, 2);

  assert.ok(
    restoredNotifications.items.every(
      (row: { status: string; last_code: string }) =>
        row.status === 'cancelled' && row.last_code === 'RESTORE_QUARANTINE',
    ),
  );

  const after = await api('/snapshot');

  assert.deepEqual(after.deployments, beforeRestart.deployments);
  assert.equal(after.releases[0].id, release.id);
  assert.ok(after.audit.some((row: { action: string }) => row.action === 'installation.restored'));
  const execution = await api('/execution');

  assert.equal(execution.agents[0].state, 'revoked');
  assert.equal(execution.targets[0].current_state, 'unknown');
  assert.equal((await http('/agent/v1/poll', {}, token, true)).status, 401);

  assert.deepEqual(
    JSON.parse(
      await compose(recovered, restored, ['run', '--rm', '--no-deps', 'operations', 'verify']),
    ),
    mfaVerification,
  );

  await assert.rejects(
    restore(saved, join(root, 'collision'), keyFile, restoredProject),
    /existing containers/,
  );

  console.log(
    'PASS: TLS, least-privilege runtime, stop barrier, durable restart, encrypted backup, corruption rejection, fresh-volume restore, retained bytes and keys, agent and identity quarantine, retained MFA and recovery-code invalidation.',
  );
} finally {
  for (const [directory, project] of [
    [original, `keel-drill-${id}`],
    [recovered, restoredProject],
  ]) {
    if (installation!) {
      await compose(directory, { ...installation, project }, [
        'down',
        '--volumes',
        '--remove-orphans',
      ]).catch(() => {});
    }
  }

  await rm(root, { recursive: true, force: true });
}
