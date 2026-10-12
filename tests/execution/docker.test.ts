import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes, X509Certificate } from 'node:crypto';
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
import { RollbackService } from '../../apps/api/src/rollback-service.js';
import { ExecutionService } from '../../apps/api/src/execution-service.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { createGateway } from '../../apps/agent-gateway/src/gateway.js';
import { dispatchOutbox } from '../../apps/workflow-worker/src/dispatcher.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { IntegrationService } from '../../apps/api/src/integration-service.js';
import { ArtifactImportWorker } from '../../apps/api/src/artifact-import-worker.js';
import { GitHubActionsAdapter } from '../../packages/integrations/src/github-actions.js';
import { githubFixture } from '../github-fixture.js';
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
let productionTargetID: string | undefined;
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

  control = new ControlPlane(
    db,
    new LocalArtifactStore(join(root, 'artifacts')),
    new CredentialVault(randomBytes(32).toString('base64'), 'deployment-secrets'),
  );

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

  for (const cleanupTarget of [targetID, productionTargetID].filter(Boolean)) {
    await run('docker', [
      'container',
      'rm',
      '--force',
      '--volumes',
      `keel-target-${cleanupTarget}`,
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

it('deploys a retained GitHub ZIP after provider expiry and recovers a crashed agent with a replacement certificate', async () => {
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

  const stagingSecretValue = `staging-private-${randomUUID()} = # $ " Unicode λ `;
  const rotatedSecretValue = `staging-rotated-${randomUUID()}`;
  const productionSecretValue = `production-private-${randomUUID()}`;

  const stagingSecret = await mutate<{ id: string }>((tx) =>
    control.secrets.create(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      name: 'APPLICATION_PASSWORD',
      value: stagingSecretValue,
    }),
  );

  await mutate((tx) =>
    control.secrets.create(tx, p, {
      project_id: project.id,
      environment_id: f.environments.production,
      name: 'APPLICATION_PASSWORD',
      value: productionSecretValue,
    }),
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
    `FROM busybox:1.37.0\nCOPY index.html /www/index.html\nUSER 65532:65532\nEXPOSE 8080\nCMD ${JSON.stringify(['sh', '-c', 'test -n "$APP_PASSWORD" && exec httpd -f -p 8080 -h /www'])}\n`,
  );

  const built = await run('docker', ['build', '--quiet', root], { timeout: 90000 });

  imageID = built.stdout.trim().split('\n').at(-1)!;
  expect(imageID).toMatch(/^sha256:[a-f0-9]{64}$/);
  const archive = join(root, 'application.tar');

  await run('docker', ['image', 'save', '--output', archive, imageID]);
  const zipPath = join(root, 'application.zip');

  await run('python3', [
    '-c',
    'import sys, zipfile; z=zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED); z.write(sys.argv[1], "application.tar"); z.close()',
    archive,
    zipPath,
  ]);

  const bytes = await readFile(zipPath);
  const github = githubFixture();

  github.state.bytes = bytes;
  github.state.artifacts[0].size_in_bytes = bytes.length;
  github.state.artifacts[0].digest = `sha256:${sha256(bytes)}`;

  const integrations = new IntegrationService(
    control,
    new CredentialVault(randomBytes(32).toString('base64')),
    (credentials) => new GitHubActionsAdapter(async () => credentials, github.transport),
  );

  const provider = await mutate<{ id: string }>((tx) =>
    integrations.create(tx, p, {
      name: 'GitHub Docker build',
      project_id: project.id,
      repository: 'keel-test/application',
      workflow_id: '42',
      branch: 'main',
      artifact_name: 'application',
      token: 'test-provider-token',
      webhook_secret: 'test-provider-webhook-secret-long-enough',
    }),
  );

  await mutate((tx) =>
    integrations.enqueue(tx, p, provider.id, { run_id: '9001', run_attempt: 1 }),
  );

  expect(await new ArtifactImportWorker(integrations).runOnce()).toBe(true);

  const artifact = (await db.query('SELECT * FROM artifacts WHERE project_id=$1', [project.id]))
    .rows[0];

  expect(artifact.digest).toBe(sha256(bytes));
  expect(artifact.provenance.source).toBe('github-actions');
  github.state.apiStatus = 410;
  github.state.bytes = Buffer.alloc(0);
  await rm(zipPath);

  const processDefinition = deploymentProcess();

  Object.assign(processDefinition.spec.artifact, {
    dockerImageId: imageID,
    dockerArchivePath: 'application.tar',
  });

  for (const environment of Object.values(processDefinition.spec.environments)) {
    Object.assign(environment, {
      strategy: 'recreate',
      verify: { http: { path: '/' } },
      secrets: { APP_PASSWORD: { secret: 'APPLICATION_PASSWORD' } },
    });
  }

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

  // Rotation after admission must not change this request's pinned version.
  await mutate((tx) =>
    control.secrets.rotate(tx, p, stagingSecret.id, {
      value: rotatedSecretValue,
      expected_revision: 1,
    }),
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

  const environment = async (id: string) =>
    JSON.parse(
      (
        await run('docker', [
          'container',
          'inspect',
          '--format',
          '{{json .Config.Env}}',
          `keel-target-${id}`,
        ])
      ).stdout,
    ) as string[];

  expect(await environment(target.id)).toContain(`APP_PASSWORD=${stagingSecretValue}`);
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
    `
      UPDATE deployment_attempts
      SET
        lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE
        deployment_id = $1
    `,
    [interrupted.id],
  );

  await execution.tick(f.org, interrupted.id);

  expect(
    (await db.query('SELECT status FROM deployments WHERE id=$1', [interrupted.id])).rows[0].status,
  ).toBe('reconciliation_required');

  await mutate((tx) => execution.agentState(tx, p, registered.id, 'revoked'));

  const replacementFingerprint = new X509Certificate(tls.unknown.cert).fingerprint256
    .replaceAll(':', '')
    .toLowerCase();

  await mutate((tx) =>
    execution.replaceCertificate(tx, p, registered.id, {
      certificate_fingerprint: replacementFingerprint,
      same_host_agent_stopped: true,
    }),
  );

  expect(await poll(tls.client)).toBe(401);
  const recoveredConfig = JSON.parse(await readFile(config, 'utf8'));

  recoveredConfig.certificate = tls.file('unknown.crt');
  recoveredConfig.key = tls.file('unknown.key');
  await writeFile(config, JSON.stringify(recoveredConfig));
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

  const progress = (
    await db.query('SELECT phase FROM deployment_attempts WHERE deployment_id=$1', [interrupted.id])
  ).rows[0];

  expect(progress.phase).toBe('cleaning_up');
  await mutate((tx) => execution.agentState(tx, p, registered.id, 'active'));
  const rollback = new RollbackService(control);

  const reviewed = await mutate<{ id: string }>((tx) =>
    rollback.create(tx, p, {
      source_deployment_id: interrupted.id,
      candidate_deployment_id: again.id,
    }),
  );

  const rollbackDeployment = await mutate<{ id: string; release_id: string; kind: string }>((tx) =>
    rollback.request(tx, p, reviewed.id),
  );

  expect(rollbackDeployment).toMatchObject({ release_id: release.id, kind: 'rollback' });
  workflowID = `deployment-${rollbackDeployment.id}`;
  await dispatchOutbox(db, client, queue);
  await until(() => completed(rollbackDeployment.id));
  await client.workflow.getHandle(workflowID).result();
  expect(await (await fetch(`http://127.0.0.1:${hostPort}`)).text()).toBe(content);
  expect(await environment(target.id)).toContain(`APP_PASSWORD=${rotatedSecretValue}`);

  // Promote the exact retained release to a second target, preserving the approval gate.
  const approver = await control.authenticate(f.approver.token);

  await control.mutate(approver, randomUUID(), randomUUID(), (tx) =>
    control.delivery.update(tx, approver, f.environments.production, {
      expected_revision: 1,
      promotion_from_environment_id: f.environments.staging,
    }),
  );

  const productionTarget = await mutate<{ id: string }>((tx) =>
    execution.registerTarget(tx, p, {
      name: 'Production target',
      project_id: project.id,
      environment_id: f.environments.production,
      agent_id: registered.id,
      labels: { tier: 'production' },
    }),
  );

  productionTargetID = productionTarget.id;
  const productionPort = await port();
  const stopped = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));

  agent!.kill('SIGTERM');
  await stopped;

  recoveredConfig.targets[productionTarget.id] = {
    host_port: productionPort,
    container_port: 8080,
  };

  await writeFile(config, JSON.stringify(recoveredConfig));
  startAgent();

  const promoted = await mutate<{
    id: string;
    status: string;
    promotion_source_deployment_id: string;
  }>((tx) =>
    control.deploy(tx, p, {
      release_id: release.id,
      environment_id: f.environments.production,
    }),
  );

  expect(promoted.status).toBe('awaiting_approval');
  expect(promoted.promotion_source_deployment_id).toBe(rollbackDeployment.id);
  await execution.tick(f.org, promoted.id);

  expect(
    (await db.query('SELECT id FROM deployment_attempts WHERE deployment_id=$1', [promoted.id]))
      .rowCount,
  ).toBe(0);

  await control.mutate(approver, randomUUID(), randomUUID(), (tx) =>
    control.transition(tx, approver, promoted.id, 'approve'),
  );

  workflowID = `deployment-${promoted.id}`;
  await dispatchOutbox(db, client, queue);
  await until(() => completed(promoted.id));
  await client.workflow.getHandle(workflowID).result();
  expect(await (await fetch(`http://127.0.0.1:${productionPort}`)).text()).toBe(content);
  expect(await environment(productionTarget.id)).toContain(`APP_PASSWORD=${productionSecretValue}`);

  expect(
    (
      await db.query('SELECT current_release_id FROM deployment_targets WHERE id=$1', [
        productionTarget.id,
      ])
    ).rows[0].current_release_id,
  ).toBe(release.id);

  // Revocation before delivery must leave the previously verified container running.
  const beforeRevocation = await run('docker', [
    'container',
    'inspect',
    '--format',
    '{{.Id}}',
    `keel-target-${target.id}`,
  ]);

  const paused = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));

  agent!.kill('SIGTERM');
  await paused;
  agent = undefined;

  const revokedDeployment = await mutate<{ id: string }>((tx) =>
    control.deploy(tx, p, {
      release_id: release.id,
      environment_id: f.environments.staging,
    }),
  );

  await mutate((tx) => control.secrets.revoke(tx, p, stagingSecret.id, 2));
  workflowID = `deployment-${revokedDeployment.id}`;
  await dispatchOutbox(db, client, queue);
  startAgent();

  await until(
    async () =>
      (await db.query('SELECT status FROM deployments WHERE id=$1', [revokedDeployment.id])).rows[0]
        .status === 'failed',
  );

  await client.workflow.getHandle(workflowID).result();

  expect(
    (await db.query('SELECT result_code FROM deployments WHERE id=$1', [revokedDeployment.id]))
      .rows[0].result_code,
  ).toBe('SECRET_UNAVAILABLE');

  const afterRevocation = await run('docker', [
    'container',
    'inspect',
    '--format',
    '{{.Id}}',
    `keel-target-${target.id}`,
  ]);

  expect(afterRevocation.stdout).toBe(beforeRevocation.stdout);
  expect(await (await fetch(`http://127.0.0.1:${hostPort}`)).text()).toBe(content);
  expect(agentOutput).not.toContain('token');

  const histories = await Promise.all(
    [again.id, interrupted.id, rollbackDeployment.id, promoted.id, revokedDeployment.id].map((id) =>
      client.workflow.getHandle(`deployment-${id}`).fetchHistory(),
    ),
  );

  const historyText = JSON.stringify(histories, (_key, value) => {
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('utf8');
    }

    if (value?.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data).toString('utf8');
    }

    return value;
  });

  for (const secretValue of [stagingSecretValue, rotatedSecretValue, productionSecretValue]) {
    expect(agentOutput).not.toContain(secretValue);
    expect(historyText).not.toContain(secretValue);
  }
}, 150000);
