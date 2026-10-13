import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { migrate } from '../../packages/database/src/migrate.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { ExecutionService } from '../../apps/api/src/execution-service.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { createGateway } from '../../apps/agent-gateway/src/gateway.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';
import { certificates } from './tls.js';

const run = promisify(execFile);
const schema = `ssh_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const host = `keel-ssh-${randomUUID()}`;
let root: string;
let gateway: Awaited<ReturnType<typeof createGateway>>;
let agent: ChildProcess | undefined;
let imageID: string | undefined;
let logs = '';

async function until(check: () => Promise<boolean>, timeout = 60000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`SSH execution timed out. ${logs}`);
}

async function stopAgent(signal: NodeJS.Signals = 'SIGTERM') {
  if (agent && agent.exitCode === null) {
    const exit = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));

    agent.kill(signal);
    await exit;
  }

  agent = undefined;
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-ssh-'));

  await run('docker', ['build', '-t', 'keel/ssh-fixture:test', 'tests/execution/ssh-fixture'], {
    timeout: 180000,
  });

  await run('docker', [
    'run',
    '-d',
    '--privileged',
    '--name',
    host,
    '-p',
    '127.0.0.1::22',
    'keel/ssh-fixture:test',
  ]);

  await until(async () => {
    try {
      await run('docker', ['exec', host, 'docker', 'info']);

      return true;
    } catch {
      return false;
    }
  });

  await run('docker', [
    'run',
    '--rm',
    '-e',
    'GOOS=linux',
    '-v',
    `${process.cwd()}:/src`,
    '-w',
    '/src/agents/deployment-agent',
    'golang:1.26-alpine',
    'go',
    'build',
    '-o',
    '/src/agents/deployment-agent/ssh-helper',
    '.',
  ]);

  await run('docker', [
    'cp',
    'agents/deployment-agent/ssh-helper',
    `${host}:/usr/local/bin/keel-agent`,
  ]);

  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'identity')]);
  await run('docker', ['cp', join(root, 'identity.pub'), `${host}:/root/.ssh/authorized_keys`]);
  await run('docker', ['exec', host, 'chown', 'root:root', '/root/.ssh/authorized_keys']);
  await run('docker', ['exec', host, 'chmod', '600', '/root/.ssh/authorized_keys']);
}, 240000);

afterAll(async () => {
  await stopAgent();
  await gateway?.close();
  await run('docker', ['rm', '-fv', host]).catch(() => {});

  if (imageID) {
    await run('docker', ['image', 'rm', imageID]).catch(() => {});
  }

  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();

  if (root) {
    await rm(root, { recursive: true, force: true });
  }

  await rm('agents/deployment-agent/ssh-helper', { force: true });
});

it('deploys over verified SSH, rejects an untrusted host and reconciles interruption before retry', async () => {
  const control = new ControlPlane(
    db,
    new LocalArtifactStore(join(root, 'artifacts')),
    new CredentialVault(randomBytes(32).toString('base64'), 'deployment-secrets'),
  );

  const execution = new ExecutionService(control);
  const f = await fixture(db);
  const p = await control.authenticate(f.operator.token);

  const mutate = <T>(work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(p, randomUUID(), randomUUID(), work) as Promise<T>;

  const tls = await certificates(root);

  gateway = await createGateway(execution, tls.server);
  const url = await gateway.listen({ host: '127.0.0.1', port: 0 });

  const registered = await mutate<{ id: string }>((tx) =>
    execution.registerAgent(tx, p, {
      name: 'SSH private agent',
      certificate_fingerprint: tls.fingerprint,
    }),
  );

  const project = await mutate<{ id: string }>((tx) =>
    control.project(tx, p, { name: 'SSH app', slug: 'ssh-app', description: '' }),
  );

  const target = await mutate<{ id: string }>((tx) =>
    execution.registerTarget(tx, p, {
      name: 'Remote Linux',
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: registered.id,
      labels: { tier: 'staging' },
      capability: 'ssh-docker-recreate-v1',
    }),
  );

  const secret = `ssh-private-${randomUUID()}`;

  await mutate((tx) =>
    control.secrets.create(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      name: 'PASSWORD',
      value: secret,
    }),
  );

  await writeFile(join(root, 'index.html'), 'SSH verified application');

  await writeFile(
    join(root, 'Dockerfile'),
    'FROM busybox:1.37.0\nCOPY index.html /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
  );

  imageID = (await run('docker', ['build', '--quiet', root])).stdout.trim().split('\n').at(-1)!;
  await run('docker', ['save', '-o', join(root, 'application.tar'), imageID]);
  const bytes = await readFile(join(root, 'application.tar'));

  const artifact = await mutate<{ id: string }>((tx) =>
    control.artifact(
      tx,
      p,
      { project_id: project.id, name: 'application', version: '1', digest: sha256(bytes) },
      bytes,
    ),
  );

  const processDefinition = deploymentProcess();

  Object.assign(processDefinition.spec.artifact, { dockerImageId: imageID });

  Object.assign(processDefinition.spec.environments.staging, {
    strategy: 'recreate',
    verify: { http: { path: '/' } },
    secrets: { APP_PASSWORD: { secret: 'PASSWORD' } },
    hooks: {
      preDeploy: {
        command: ['/bin/sh', '-c', 'test -n "$APP_PASSWORD" && echo "$APP_PASSWORD"'],
        timeoutSeconds: 10,
        secrets: ['APP_PASSWORD'],
      },
      postDeploy: { command: ['/bin/sh', '-c', 'test -z "$APP_PASSWORD"'], timeoutSeconds: 10 },
    },
  });

  const release = await mutate<{ id: string }>((tx) =>
    control.release(tx, p, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: '1',
      process: processDefinition,
    }),
  );

  const hostPort = Number(
    (await run('docker', ['port', host, '22/tcp'])).stdout.trim().split(':').at(-1),
  );

  const hostKey = (
    await run('docker', ['exec', host, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])
  ).stdout.trim();

  const knownHosts = join(root, 'known_hosts');

  await writeFile(knownHosts, '');
  const config = join(root, 'agent.json');

  await writeFile(
    config,
    JSON.stringify({
      gateway: url,
      certificate: tls.file('client.crt'),
      key: tls.file('client.key'),
      ca: tls.file('ca.crt'),
      state_directory: join(root, 'state'),
      targets: {
        [target.id]: {
          host_port: 18080,
          container_port: 8080,
          ssh: {
            host: '127.0.0.1',
            port: hostPort,
            user: 'root',
            identity_file: join(root, 'identity'),
            known_hosts_file: knownHosts,
            helper_path: '/usr/local/bin/keel-agent',
            state_directory: '/var/lib/keel',
          },
        },
      },
    }),
  );

  const start = () => {
    agent = spawn(resolve('agents/deployment-agent/deployment-agent'), [config], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    agent.stderr!.on('data', (chunk) => {
      logs += chunk.toString();
    });
  };

  const deploy = async (releaseID = release.id) => {
    const d = await mutate<{ id: string }>((tx) =>
      control.deploy(tx, p, { release_id: releaseID, environment_id: f.environments.staging }),
    );

    await execution.tick(f.org, d.id);

    return d;
  };

  const state = async (id: string) =>
    (await db.query('SELECT status FROM deployments WHERE id=$1', [id])).rows[0].status;

  const rejected = await deploy();

  start();
  await until(async () => logs.includes('reconciliation required'));
  expect(await state(rejected.id)).toBe('running');
  expect((await run('docker', ['exec', host, 'docker', 'ps', '-aq'])).stdout.trim()).toBe('');
  await stopAgent();

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE deployment_id=$1",
    [rejected.id],
  );

  await execution.tick(f.org, rejected.id);
  expect(await state(rejected.id)).toBe('reconciliation_required');
  await writeFile(knownHosts, `[127.0.0.1]:${hostPort} ${hostKey}\n`);

  await run('ssh', [
    '-F',
    '/dev/null',
    '-T',
    '-p',
    String(hostPort),
    '-i',
    join(root, 'identity'),
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentityAgent=none',
    'root@127.0.0.1',
    'true',
  ]).catch(async (error) => {
    throw new Error(`${error}\n${(await run('docker', ['logs', host])).stderr}`);
  });

  start();
  await until(async () => (await state(rejected.id)) === 'failed');
  const success = await deploy();

  await until(async () => {
    const status = await state(success.id);

    if (status === 'failed') {
      throw new Error(
        `${logs}\n${(await run('docker', ['exec', host, 'cat', '/tmp/docker.log'])).stdout}`,
      );
    }

    return status === 'succeeded';
  });

  expect(
    (await run('docker', ['exec', host, 'wget', '-qO-', 'http://127.0.0.1:18080/'])).stdout,
  ).toBe('SSH verified application');

  expect(
    (
      await run('docker', [
        'exec',
        host,
        'docker',
        'inspect',
        '--format',
        '{{json .Config.Env}}',
        `keel-target-${target.id}`,
      ])
    ).stdout,
  ).toContain(`APP_PASSWORD=${secret}`);

  Object.assign(processDefinition.spec.environments.staging, {
    verify: { http: { path: '/missing' } },
  });

  const broken = await mutate<{ id: string }>((tx) =>
    control.release(tx, p, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: '2',
      process: processDefinition,
    }),
  );

  const interrupted = await deploy(broken.id);

  await until(
    async () =>
      (
        await db.query('SELECT phase FROM deployment_attempts WHERE deployment_id=$1', [
          interrupted.id,
        ])
      ).rows[0]?.phase === 'verifying_http',
  );

  await stopAgent('SIGKILL');

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE deployment_id=$1",
    [interrupted.id],
  );

  await execution.tick(f.org, interrupted.id);
  expect(await state(interrupted.id)).toBe('reconciliation_required');
  start();
  await until(async () => (await state(interrupted.id)) === 'failed');
  expect((await run('docker', ['exec', host, 'docker', 'ps', '-aq'])).stdout.trim()).toBe('');

  const cancelled = await deploy(broken.id);

  await until(
    async () =>
      (
        await db.query('SELECT phase FROM deployment_attempts WHERE deployment_id=$1', [
          cancelled.id,
        ])
      ).rows[0]?.phase === 'verifying_http',
  );

  await mutate((tx) => control.transition(tx, p, cancelled.id, 'cancel'));
  await until(async () => (await state(cancelled.id)) === 'cancelled');
  expect((await run('docker', ['exec', host, 'docker', 'ps', '-aq'])).stdout.trim()).toBe('');
  const retried = await deploy();

  await until(async () => (await state(retried.id)) === 'succeeded');
  expect(logs).not.toContain(secret);
  expect(await readFile(config, 'utf8')).not.toContain(secret);
}, 150000);
