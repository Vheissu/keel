import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:https';
import { createServer } from 'node:net';
import pg from 'pg';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { migrate } from '../../packages/database/src/migrate.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { ExecutionService } from '../../apps/api/src/execution-service.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { createGateway } from '../../apps/agent-gateway/src/gateway.js';
import { dispatchOutbox } from '../../apps/workflow-worker/src/dispatcher.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';
import { certificates } from './tls.js';

const run = promisify(execFile);
const schema = `docker_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const queue = `test-${randomUUID()}`;
let root: string;
let control: ControlPlane;
let execution: ExecutionService;
let tls: Awaited<ReturnType<typeof certificates>>;
let gateway: Awaited<ReturnType<typeof createGateway>>;
let url: string;
let connection: Connection;
let native: NativeConnection;
let client: Client;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let agent: ChildProcess | undefined;
let targetID: string | undefined;
let imageID: string | undefined;
let workflowID: string | undefined;

async function until(check: () => Promise<boolean>, timeout = 60000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for deployment state.');
}

async function startWorker() {
  worker = await Worker.create({
    connection: native,
    namespace: 'default',
    taskQueue: queue,
    workflowBundle: { codePath: resolve('apps/workflow-worker/dist/workflows.cjs') },
    activities: { tick: execution.tick.bind(execution) },
    shutdownGraceTime: '1 second',
  });

  workerRun = worker.run();
}

async function port() {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return value;
}

async function poll(credentials: object, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      `${url}/agent/v1/poll`,
      {
        method: 'POST',
        ...credentials,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );

    req.on('error', reject);
    req.end('{}');
  });
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-docker-'));
  control = new ControlPlane(db, new LocalArtifactStore(join(root, 'artifacts')));
  execution = new ExecutionService(control);
  tls = await certificates(root);
  gateway = await createGateway(execution, tls.server);
  url = await gateway.listen({ host: '127.0.0.1', port: 0 });

  connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7233',
  });

  native = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7233',
  });

  client = new Client({ connection });
}, 60000);

afterAll(async () => {
  agent?.kill('SIGTERM');

  if (agent && agent.exitCode === null) {
    await new Promise<void>((resolve) => {
      agent!.once('exit', () => resolve());

      setTimeout(() => {
        agent?.kill('SIGKILL');
        resolve();
      }, 5000).unref();
    });
  }

  if (worker) {
    worker.shutdown();
    await workerRun;
  }

  if (workflowID) {
    await client.workflow
      .getHandle(workflowID)
      .terminate('Test cleanup')
      .catch(() => {});
  }

  await native?.close();
  await connection?.close();
  await gateway?.close();

  if (targetID) {
    await run('docker', [
      'container',
      'rm',
      '--force',
      '--volumes',
      `keel-target-${targetID}`,
    ]).catch(() => {});
  }

  if (imageID) {
    await run('docker', ['image', 'rm', imageID]).catch(() => {});
  }

  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

it('rejects missing, unregistered and spoofed client identities at the real TLS gateway', async () => {
  await expect(poll({ ca: tls.client.ca })).rejects.toThrow();

  expect(
    await poll(tls.unknown, { 'x-agent-id': randomUUID(), 'x-client-cert': tls.fingerprint }),
  ).toBe(401);
});

it('runs a retained Docker image through Temporal, survives worker restart and redeploys without the source image', async () => {
  const f = await fixture(db);
  const p = await control.authenticate(f.operator.token);

  const mutate = <T>(work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(p, randomUUID(), randomUUID(), work) as Promise<T>;

  const registered = await mutate<{ id: string }>((tx) =>
    execution.registerAgent(tx, p, {
      name: 'Docker test host',
      certificate_fingerprint: tls.fingerprint,
    }),
  );

  const project = await mutate<{ id: string }>((tx) =>
    control.project(tx, p, { name: 'Retained Docker application', slug: 'web', description: '' }),
  );

  const target = await mutate<{ id: string }>((tx) =>
    execution.registerTarget(tx, p, {
      name: 'Test Docker target',
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: registered.id,
      labels: { tier: 'staging' },
    }),
  );

  targetID = target.id;
  const content = `Keel retained deployment ${randomUUID()}`;

  await writeFile(join(root, 'index.html'), content);

  await writeFile(
    join(root, 'Dockerfile'),
    'FROM busybox:1.37.0\nCOPY index.html /www/index.html\nUSER 65532:65532\nEXPOSE 8080\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
  );

  const built = await run('docker', ['build', '--quiet', root], { timeout: 90000 });

  imageID = built.stdout.trim().split('\n').at(-1)!;
  expect(imageID).toMatch(/^sha256:[a-f0-9]{64}$/);
  const archive = join(root, 'application.tar');

  await run('docker', ['image', 'save', '--output', archive, imageID]);
  const bytes = await readFile(archive);

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
  });

  const release = await mutate<{ id: string }>((tx) =>
    control.release(tx, p, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: '1',
      process: processDefinition,
    }),
  );

  // Neither a registry nor the original Docker image is available for the execution.
  await run('docker', ['image', 'rm', imageID]);
  await rm(archive);
  const hostPort = await port();
  const context = JSON.parse((await run('docker', ['context', 'inspect'])).stdout)[0];
  const socket = process.env.DOCKER_HOST || context.Endpoints.docker.Host;

  expect(socket).toMatch(/^unix:\/\//);
  const config = join(root, 'agent.json');

  await writeFile(
    config,
    JSON.stringify({
      gateway: url,
      certificate: tls.file('client.crt'),
      key: tls.file('client.key'),
      ca: tls.file('ca.crt'),
      state_directory: join(root, 'agent-state'),
      docker_socket: socket.slice(7),
      targets: { [target.id]: { host_port: hostPort, container_port: 8080 } },
    }),
  );

  const deployment = await mutate<{ id: string }>((tx) =>
    control.deploy(tx, p, { release_id: release.id, environment_id: f.environments.staging }),
  );

  workflowID = `deployment-${deployment.id}`;
  await startWorker();
  await dispatchOutbox(db, client, queue);

  await until(
    async () =>
      Number(
        (
          await db.query('SELECT count(*) FROM deployment_attempts WHERE deployment_id=$1', [
            deployment.id,
          ])
        ).rows[0].count,
      ) === 1,
  );

  worker!.shutdown();
  await workerRun;
  worker = undefined;
  await db.query("UPDATE outbox SET delivered_at=NULL WHERE topic='deployment.queued'");
  await dispatchOutbox(db, client, queue);
  await startWorker();
  let agentOutput = '';

  const startAgent = () => {
    agent = spawn(resolve('agents/deployment-agent/deployment-agent'), [config], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    agent.stderr!.on('data', (chunk) => {
      agentOutput += chunk.toString();
    });
  };

  startAgent();

  const completed = async (id: string) => {
    const d = (await db.query('SELECT status,result_code FROM deployments WHERE id=$1', [id]))
      .rows[0];

    if (d.status === 'failed' || d.status === 'reconciliation_required') {
      throw new Error(`${JSON.stringify(d)}\n${agentOutput}`);
    }

    return d.status === 'succeeded';
  };

  await until(() => completed(deployment.id));
  expect(await (await fetch(`http://127.0.0.1:${hostPort}`)).text()).toBe(content);
  await client.workflow.getHandle(workflowID).result();

  const first = (
    await db.query('SELECT fence FROM deployment_attempts WHERE deployment_id=$1', [deployment.id])
  ).rows[0].fence;

  const again = await mutate<{ id: string }>((tx) =>
    control.deploy(tx, p, { release_id: release.id, environment_id: f.environments.staging }),
  );

  workflowID = `deployment-${again.id}`;
  await dispatchOutbox(db, client, queue);
  await until(() => completed(again.id));
  await client.workflow.getHandle(workflowID).result();
  expect(await (await fetch(`http://127.0.0.1:${hostPort}`)).text()).toBe(content);

  const current = (
    await db.query(
      'SELECT fence,current_state,current_release_id FROM deployment_targets WHERE id=$1',
      [target.id],
    )
  ).rows[0];

  expect(current).toEqual({
    fence: first + 1,
    current_state: 'verified',
    current_release_id: release.id,
  });

  const inspect = JSON.parse(
    (await run('docker', ['container', 'inspect', `keel-target-${target.id}`])).stdout,
  )[0];

  expect(inspect.HostConfig.Privileged).toBe(false);
  expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
  expect(inspect.Config.User).toBe('65532:65532');
  expect(inspect.HostConfig.CapDrop).toContain('ALL');

  // Kill the agent after Docker starts but before a failing health path can verify.
  processDefinition.spec.environments.staging = {
    ...processDefinition.spec.environments.staging,
    ...{ verify: { http: { path: '/missing-health' } } },
  };

  const interruptedRelease = await mutate<{ id: string }>((tx) =>
    control.release(tx, p, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: 'interrupted',
      process: processDefinition,
    }),
  );

  const interrupted = await mutate<{ id: string }>((tx) =>
    control.deploy(tx, p, {
      release_id: interruptedRelease.id,
      environment_id: f.environments.staging,
    }),
  );

  workflowID = `deployment-${interrupted.id}`;
  await dispatchOutbox(db, client, queue);

  await until(async () => {
    const row = (
      await db.query('SELECT id FROM deployment_attempts WHERE deployment_id=$1', [interrupted.id])
    ).rows[0];

    if (!row) {
      return false;
    }

    const result = await run('docker', [
      'container',
      'inspect',
      '--format',
      '{{index .Config.Labels "keel.attempt"}} {{.State.Running}}',
      `keel-target-${target.id}`,
    ]).catch(() => null);

    return result?.stdout.trim() === `${row.id} true`;
  });

  const exited = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));

  agent!.kill('SIGKILL');
  await exited;
  agent = undefined;

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE deployment_id=$1",
    [interrupted.id],
  );

  await execution.tick(f.org, interrupted.id);

  expect(
    (await db.query('SELECT status FROM deployments WHERE id=$1', [interrupted.id])).rows[0].status,
  ).toBe('reconciliation_required');

  startAgent();

  await until(
    async () =>
      (await db.query('SELECT status FROM deployments WHERE id=$1', [interrupted.id])).rows[0]
        .status === 'failed',
  );

  await client.workflow.getHandle(workflowID).result();

  expect(
    (await db.query('SELECT result_code FROM deployments WHERE id=$1', [interrupted.id])).rows[0]
      .result_code,
  ).toBe('RECONCILED');

  expect(
    (
      await run('docker', [
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/keel-target-${target.id}$`,
        '--format',
        '{{.ID}}',
      ])
    ).stdout.trim(),
  ).toBe('');

  expect(
    (await db.query('SELECT current_state FROM deployment_targets WHERE id=$1', [target.id]))
      .rows[0].current_state,
  ).toBe('unknown');

  expect(agentOutput).not.toContain('token');
}, 150000);
