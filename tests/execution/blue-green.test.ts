import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import pg from 'pg';
import { migrate } from '../../packages/database/src/migrate.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { ExecutionService } from '../../apps/api/src/execution-service.js';
import { RollbackService } from '../../apps/api/src/rollback-service.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { createGateway } from '../../apps/agent-gateway/src/gateway.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';
import { certificates } from './tls.js';

const run = promisify(execFile);
const schema = `bluegreen_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let root: string;
let control: ControlPlane;
let execution: ExecutionService;
let tls: Awaited<ReturnType<typeof certificates>>;
let gateway: Awaited<ReturnType<typeof createGateway>>;
let agent: ChildProcess | undefined;
let targetID: string;
const images: string[] = [];
let output = '';
let holdResult = false;
let resultWaiting = false;
let releaseResult: (() => void) | undefined;

async function until(check: () => Promise<boolean>, timeout = 60000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out. Agent output:\n${output}`);
}

async function port() {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return value;
}

async function stopAgent() {
  if (agent && agent.exitCode === null && agent.signalCode === null) {
    const stopped = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));

    agent.kill('SIGKILL');
    await stopped;
  }

  agent = undefined;
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-bluegreen-'));
  control = new ControlPlane(db, new LocalArtifactStore(join(root, 'artifacts')));
  execution = new ExecutionService(control);
  tls = await certificates(root);
  gateway = await createGateway(execution, tls.server);

  gateway.addHook('preHandler', async (req, reply) => {
    if (holdResult && req.url === '/agent/v1/result') {
      resultWaiting = true;

      await new Promise<void>((resolve) => {
        releaseResult = resolve;
      });

      return reply.code(503).send({ error: 'simulated outage before result commit' });
    }
  });
});

afterAll(async () => {
  await stopAgent();
  releaseResult?.();
  await gateway?.close();

  if (targetID) {
    for (const slot of ['blue', 'green']) {
      await run('docker', [
        'container',
        'rm',
        '--force',
        '--volumes',
        `keel-target-${targetID}-${slot}`,
      ]).catch(() => {});
    }
  }

  for (const image of images) {
    await run('docker', ['image', 'rm', image]).catch(() => {});
  }

  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

it('switches healthy slots, preserves service on failures and cancellation, and restores the prior route after a crash', async () => {
  const f = await fixture(db);
  const p = await control.authenticate(f.operator.token);

  const mutate = <T>(work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(p, randomUUID(), randomUUID(), work) as Promise<T>;

  const registered = await mutate<{ id: string }>((tx) =>
    execution.registerAgent(tx, p, {
      name: 'Blue green host',
      certificate_fingerprint: tls.fingerprint,
    }),
  );

  const project = await mutate<{ id: string }>((tx) =>
    control.project(tx, p, { name: 'Blue green application', slug: 'web', description: '' }),
  );

  const target = await mutate<{ id: string }>((tx) =>
    execution.registerTarget(tx, p, {
      name: 'Blue green local',
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: registered.id,
      capability: 'docker-blue-green-v1',
      labels: { tier: 'staging' },
    }),
  );

  targetID = target.id;
  const hostPort = await port();
  const bluePort = await port();
  const greenPort = await port();
  const url = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const dockerContext = JSON.parse((await run('docker', ['context', 'inspect'])).stdout)[0];
  const socket = process.env.DOCKER_HOST || dockerContext.Endpoints.docker.Host;
  const config = join(root, 'agent.json');

  await writeFile(
    config,
    JSON.stringify({
      gateway: url,
      certificate: tls.file('client.crt'),
      key: tls.file('client.key'),
      ca: tls.file('ca.crt'),
      state_directory: join(root, 'state'),
      docker_socket: socket.slice(7),
      targets: {
        [target.id]: {
          host_port: hostPort,
          container_port: 8080,
          blue_green: { blue_port: bluePort, green_port: greenPort },
        },
      },
    }),
  );

  const startAgent = () => {
    agent = spawn(resolve('agents/deployment-agent/deployment-agent'), [config], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    agent.stderr!.on('data', (chunk) => {
      output += chunk.toString();
    });
  };

  const body = async () => (await fetch(`http://127.0.0.1:${hostPort}`)).text();
  const releases: { id: string }[] = [];

  for (const version of ['one', 'two']) {
    await writeFile(join(root, 'index.html'), version);

    await writeFile(
      join(root, 'Dockerfile'),
      'FROM busybox:1.37.0\nCOPY index.html /www/index.html\nUSER 65532:65532\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
    );

    const built = await run('docker', ['build', '--quiet', root], { timeout: 90000 });
    const image = built.stdout.trim().split('\n').at(-1)!;

    images.push(image);
    const archive = join(root, 'image.tar');

    await run('docker', ['image', 'save', '--output', archive, image]);
    const bytes = await readFile(archive);

    const artifact = await mutate<{ id: string }>((tx) =>
      control.artifact(
        tx,
        p,
        { project_id: project.id, name: 'application', version, digest: sha256(bytes) },
        bytes,
      ),
    );

    const process = deploymentProcess();

    Object.assign(process.spec.artifact, { dockerImageId: image });

    Object.assign(process.spec.environments.staging, {
      strategy: 'blue-green',
      verify: { http: { path: '/' } },
    });

    releases.push(
      await mutate((tx) =>
        control.release(tx, p, {
          project_id: project.id,
          artifact_id: artifact.id,
          version,
          process,
        }),
      ),
    );

    if (version === 'two') {
      Object.assign(process.spec.environments.staging, { verify: { http: { path: '/missing' } } });

      releases.push(
        await mutate((tx) =>
          control.release(tx, p, {
            project_id: project.id,
            artifact_id: artifact.id,
            version: 'unhealthy',
            process,
          }),
        ),
      );
    }
  }

  const deploy = async (release: { id: string }) => {
    const d = await mutate<{ id: string }>((tx) =>
      control.deploy(tx, p, { release_id: release.id, environment_id: f.environments.staging }),
    );

    await execution.tick(f.org, d.id);

    return d;
  };

  const waitStatus = async (d: { id: string }, status: string) => {
    await until(
      async () =>
        (await db.query('SELECT status FROM deployments WHERE id=$1', [d.id])).rows[0].status ===
        status,
    );
  };

  const waitPhase = async (d: { id: string }, phase: string) => {
    await until(
      async () =>
        (await db.query('SELECT phase FROM deployment_attempts WHERE deployment_id=$1', [d.id]))
          .rows[0]?.phase === phase,
    );
  };

  const expectRecovery = async (d: { id: string }) => {
    expect(
      (await db.query('SELECT recovery FROM deployment_attempts WHERE deployment_id=$1', [d.id]))
        .rows[0].recovery,
    ).toBe('previous_route_restored');

    expect(await body()).toBe('two');
  };

  startAgent();
  const first = await deploy(releases[0]);

  await waitStatus(first, 'succeeded');
  expect(await body()).toBe('one');
  const second = await deploy(releases[1]);

  await waitStatus(second, 'succeeded');
  expect(await body()).toBe('two');

  const failed = await deploy(releases[2]);

  await waitPhase(failed, 'verifying_http');
  expect(await body()).toBe('two');
  await waitStatus(failed, 'failed');
  await expectRecovery(failed);

  const cancelled = await deploy(releases[2]);

  await waitPhase(cancelled, 'verifying_http');
  await mutate((tx) => control.transition(tx, p, cancelled.id, 'cancel'));
  await waitStatus(cancelled, 'cancelled');
  await expectRecovery(cancelled);

  // Kill after the durable traffic switch, before the control plane accepts success.
  holdResult = true;
  const interrupted = await deploy(releases[0]);

  await until(async () => resultWaiting);
  expect(await body()).toBe('one');
  await stopAgent();
  holdResult = false;
  releaseResult!();

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE deployment_id=$1",
    [interrupted.id],
  );

  await execution.tick(f.org, interrupted.id);
  await waitStatus(interrupted, 'reconciliation_required');
  startAgent();
  await waitStatus(interrupted, 'failed');
  await expectRecovery(interrupted);

  // Explicit rollback uses the retained strategy and its compatibility preflight.
  const rollback = new RollbackService(control);

  const plan = await mutate<{ id: string; strategy: string }>((tx) =>
    rollback.create(tx, p, {
      source_deployment_id: interrupted.id,
      candidate_deployment_id: second.id,
    }),
  );

  expect(plan.strategy).toBe('blue-green');
  const rolledBack = await mutate<{ id: string }>((tx) => rollback.request(tx, p, plan.id));

  await execution.tick(f.org, rolledBack.id);
  await waitStatus(rolledBack, 'succeeded');
  expect(await body()).toBe('two');
  await stopAgent();
  startAgent();

  await until(async () => {
    try {
      return (await body()) === 'two';
    } catch {
      return false;
    }
  });
}, 150000);
