import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
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
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { createGateway } from '../../apps/agent-gateway/src/gateway.js';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';
import { certificates } from './tls.js';

const run = promisify(execFile);
const schema = `hooks_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let root: string;
let control: ControlPlane;
let execution: ExecutionService;
let tls: Awaited<ReturnType<typeof certificates>>;
let gateway: Awaited<ReturnType<typeof createGateway>>;
let agent: ChildProcess | undefined;
const targets: string[] = [];
const images: string[] = [];
let output = '';

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
  root = await mkdtemp(join(tmpdir(), 'keel-hooks-'));

  control = new ControlPlane(
    db,
    new LocalArtifactStore(join(root, 'artifacts')),
    new CredentialVault(randomBytes(32).toString('base64'), 'deployment-secrets'),
  );

  execution = new ExecutionService(control);
  tls = await certificates(root);
  gateway = await createGateway(execution, tls.server);
});

afterAll(async () => {
  await stopAgent();
  await gateway?.close();

  for (const target of targets) {
    const ids = (
      await run('docker', [
        'container',
        'ls',
        '--all',
        '--quiet',
        '--filter',
        `label=keel.target=${target}`,
      ])
    ).stdout
      .trim()
      .split('\n')
      .filter(Boolean);

    if (ids.length) {
      await run('docker', ['container', 'rm', '--force', '--volumes', ...ids]);
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

it('bounds hooks, isolates secrets and preserves or removes the application according to the failed phase', async () => {
  const f = await fixture(db);
  const p = await control.authenticate(f.operator.token);

  const mutate = <T>(work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(p, randomUUID(), randomUUID(), work) as Promise<T>;

  const registered = await mutate<{ id: string }>((tx) =>
    execution.registerAgent(tx, p, {
      name: 'Lifecycle host',
      certificate_fingerprint: tls.fingerprint,
    }),
  );

  const project = await mutate<{ id: string }>((tx) =>
    control.project(tx, p, { name: 'Hook application', slug: 'hooks', description: '' }),
  );

  const secret = `private-hook-${randomUUID()}`;

  for (const name of ['PASSWORD', 'OTHER']) {
    await mutate((tx) =>
      control.secrets.create(tx, p, {
        project_id: project.id,
        environment_id: f.environments.staging,
        name,
        value: name === 'PASSWORD' ? secret : 'not-for-hooks',
      }),
    );
  }

  const localTargets: Record<string, object> = {};
  const ports: number[] = [];

  for (const strategy of ['recreate', 'blue-green']) {
    const target = await mutate<{ id: string }>((tx) =>
      execution.registerTarget(tx, p, {
        name: strategy,
        project_id: project.id,
        environment_id: f.environments.staging,
        agent_id: registered.id,
        capability: strategy === 'recreate' ? 'docker-recreate-v1' : 'docker-blue-green-v1',
        labels: { strategy },
      }),
    );

    targets.push(target.id);
    const hostPort = await port();

    ports.push(hostPort);

    localTargets[target.id] = {
      host_port: hostPort,
      container_port: 8080,
      ...(strategy === 'blue-green'
        ? { blue_green: { blue_port: await port(), green_port: await port() } }
        : {}),
    };
  }

  await writeFile(join(root, 'index.html'), 'healthy application');

  await writeFile(
    join(root, 'Dockerfile'),
    'FROM busybox:1.37.0\nCOPY index.html /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
  );

  const image = (await run('docker', ['build', '--quiet', root])).stdout.trim().split('\n').at(-1)!;

  images.push(image);
  await run('docker', ['image', 'save', '--output', join(root, 'image.tar'), image]);
  const bytes = await readFile(join(root, 'image.tar'));

  const artifact = await mutate<{ id: string }>((tx) =>
    control.artifact(
      tx,
      p,
      { project_id: project.id, name: 'application', version: '1', digest: sha256(bytes) },
      bytes,
    ),
  );

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
      targets: localTargets,
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

  type Hook = { command: string[]; timeoutSeconds: number; secrets?: string[]; network?: string };

  const hook = (command: string, timeoutSeconds = 15): Hook => ({
    command: ['/bin/sh', '-c', command],
    timeoutSeconds,
  });

  const deploy = async (hooks?: { preDeploy?: Hook; postDeploy?: Hook }, strategy = 'recreate') => {
    const process = deploymentProcess();

    Object.assign(process.spec.artifact, { dockerImageId: image });

    Object.assign(process.spec.environments.staging, {
      strategy,
      targetSelector: { labels: { strategy } },
      verify: { http: { path: '/' } },
      secrets: { APP_PASSWORD: { secret: 'PASSWORD' }, OTHER_SECRET: { secret: 'OTHER' } },
      ...(hooks ? { hooks } : {}),
    });

    const release = await mutate<{ id: string }>((tx) =>
      control.release(tx, p, {
        project_id: project.id,
        artifact_id: artifact.id,
        version: randomUUID(),
        process,
      }),
    );

    const d = await mutate<{ id: string }>((tx) =>
      control.deploy(tx, p, { release_id: release.id, environment_id: f.environments.staging }),
    );

    await execution.tick(f.org, d.id);

    return d;
  };

  const waitResult = async (d: { id: string }, code: string) => {
    await until(async () => {
      const row = (await db.query('SELECT status,result_code FROM deployments WHERE id=$1', [d.id]))
        .rows[0];

      if (!['succeeded', 'failed', 'cancelled'].includes(row.status)) {
        return false;
      }

      expect(row.result_code, output).toBe(code);

      return true;
    });
  };

  const applicationID = async () =>
    (
      await run('docker', [
        'container',
        'inspect',
        '--format',
        '{{.Id}}',
        `keel-target-${targets[0]}`,
      ])
    ).stdout.trim();

  const waitHook = async (d: { id: string }, phase = 'pre') => {
    let name = '';

    await until(async () => {
      const attempt = (
        await db.query('SELECT id FROM deployment_attempts WHERE deployment_id=$1', [d.id])
      ).rows[0];

      name = `keel-target-${targets[0]}-hook-${attempt.id}-${phase}`;

      try {
        return (
          (
            await run('docker', ['container', 'inspect', '--format', '{{.State.Running}}', name])
          ).stdout.trim() === 'true'
        );
      } catch {
        return false;
      }
    });

    return name;
  };

  startAgent();
  await waitResult(await deploy(), 'HTTP_VERIFIED');
  const original = await applicationID();

  for (const [preDeploy, code] of [
    [hook('exit 7'), 'PRE_HOOK_FAILED'],
    [hook('sleep 60', 1), 'PRE_HOOK_TIMEOUT'],
    [{ ...hook('exit 0'), network: 'target' }, 'HOOK_NETWORK_UNAVAILABLE'],
  ] as const) {
    await waitResult(await deploy({ preDeploy }), code);
    expect(await applicationID()).toBe(original);
  }

  const waiting = { ...hook('echo "$APP_PASSWORD"; sleep 60', 120), secrets: ['APP_PASSWORD'] };
  const cancelled = await deploy({ preDeploy: waiting });
  const hookName = await waitHook(cancelled);

  const inspection = JSON.parse(
    (await run('docker', ['container', 'inspect', hookName])).stdout,
  )[0];

  expect(inspection.Config.Env).toContain(`APP_PASSWORD=${secret}`);

  expect(inspection.Config.Env.some((value: string) => value.startsWith('OTHER_SECRET='))).toBe(
    false,
  );

  expect(inspection.HostConfig.LogConfig.Type).toBe('none');
  expect(inspection.HostConfig.NetworkMode).toBe('none');
  await mutate((tx) => control.transition(tx, p, cancelled.id, 'cancel'));
  await waitResult(cancelled, 'CANCELLED');
  expect(await applicationID()).toBe(original);

  const interrupted = await deploy({ preDeploy: { ...waiting, timeoutSeconds: 10 } });

  const interruptedHook = await waitHook(interrupted);

  await stopAgent();

  // The image's timer must stop the hook even while the agent is dead.
  await until(async () => {
    const result = await run('docker', [
      'container',
      'inspect',
      '--format',
      '{{.State.Running}}',
      interruptedHook,
    ]);

    return result.stdout.trim() === 'false';
  }, 15000);

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE deployment_id=$1",
    [interrupted.id],
  );

  await execution.tick(f.org, interrupted.id);
  startAgent();
  await waitResult(interrupted, 'RECONCILED');
  expect(await applicationID()).toBe(original);

  await waitResult(await deploy({ postDeploy: hook('exit 9') }), 'POST_HOOK_FAILED');
  await expect(applicationID()).rejects.toThrow();

  await waitResult(
    await deploy({
      preDeploy: {
        ...hook('test -n "$APP_PASSWORD" && test -z "$OTHER_SECRET"'),
        secrets: ['APP_PASSWORD'],
      },
      postDeploy: hook('test -z "$APP_PASSWORD" && test -z "$OTHER_SECRET"'),
    }),
    'HTTP_VERIFIED',
  );

  const blue = await deploy(undefined, 'blue-green');

  await waitResult(blue, 'HTTP_VERIFIED');

  const activeRoute = JSON.parse(
    await readFile(join(root, 'state', `route-${targets[1]}.json`), 'utf8'),
  ).active;

  const postFailed = await deploy({ postDeploy: hook('exit 4') }, 'blue-green');

  await waitResult(postFailed, 'POST_HOOK_FAILED');

  expect(
    JSON.parse(await readFile(join(root, 'state', `route-${targets[1]}.json`), 'utf8')).active,
  ).toEqual(activeRoute);

  expect(
    (
      await db.query('SELECT recovery FROM deployment_attempts WHERE deployment_id=$1', [
        postFailed.id,
      ])
    ).rows[0].recovery,
  ).toBe('previous_route_restored');

  expect(await (await fetch(`http://127.0.0.1:${ports[1]}`)).text()).toBe('healthy application');

  const book = await mutate<{ id: string }>((tx) =>
    control.runbooks.create(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      name: 'Maintenance',
      slug: 'maintenance',
      description: '',
    }),
  );

  let revision = 0;

  const runbook = async (task: Hook, targetId = targets[0]) => {
    const version = await mutate<{ id: string }>((tx) =>
      control.runbooks.publish(tx, p, book.id, {
        artifact_id: artifact.id,
        expected_revision: revision++,
        process: {
          apiVersion: 'keel.dev/v1alpha1',
          kind: 'Runbook',
          spec: {
            artifact: { dockerImageId: image },
            task,
            requiresApproval: false,
            secrets: { TASK_PASSWORD: { secret: 'PASSWORD' } },
            inputs: {
              LABEL: { type: 'string', maxLength: 80 },
              LIMIT: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
              APPLY: { type: 'boolean', default: false },
              REGION: { type: 'enum', choices: ['east', 'west'], default: 'east' },
            },
          },
        },
      }),
    );

    const plan = await mutate<{ id: string }>((tx) =>
      control.runbooks.review(tx, p, {
        runbook_version_id: version.id,
        target_id: targetId,
        inputs: { LABEL: '$(touch /tmp/injected)', REGION: 'west' },
      }),
    );

    const result = await mutate<{ id: string }>((tx) => control.runbooks.request(tx, p, plan.id));

    await execution.tick(f.org, result.id);

    return result;
  };

  const retainedApplication = await applicationID();

  for (const [task, code] of [
    [
      hook(
        'test -n "$TASK_PASSWORD" && test -z "$OTHER_SECRET" && test "$KEEL_INPUT_LABEL" = \'$(touch /tmp/injected)\' && test ! -e /tmp/injected && test "$KEEL_INPUT_LIMIT" = 0 && test "$KEEL_INPUT_APPLY" = false',
      ),
      'RUNBOOK_SUCCEEDED',
    ],
    [hook('exit 7'), 'RUNBOOK_FAILED'],
    [hook('sleep 60', 1), 'RUNBOOK_TIMEOUT'],
  ] as const) {
    await waitResult(await runbook(task), code);
    expect(await applicationID()).toBe(retainedApplication);
  }

  await waitResult(await runbook(hook('exit 7'), targets[1]), 'RUNBOOK_FAILED');

  expect(
    JSON.parse(await readFile(join(root, 'state', `route-${targets[1]}.json`), 'utf8')).active,
  ).toEqual(activeRoute);

  expect(await (await fetch(`http://127.0.0.1:${ports[1]}`)).text()).toBe('healthy application');

  const cancelledTask = await runbook(hook('echo "$TASK_PASSWORD"; sleep 60', 120));
  const taskName = await waitHook(cancelledTask, 'runbook');

  const taskInspection = JSON.parse(
    (await run('docker', ['container', 'inspect', taskName])).stdout,
  )[0];

  expect(taskInspection.Config.Env).toContain(`TASK_PASSWORD=${secret}`);

  expect(taskInspection.Config.Env).toEqual(
    expect.arrayContaining([
      'KEEL_INPUT_LABEL=$(touch /tmp/injected)',
      'KEEL_INPUT_LIMIT=0',
      'KEEL_INPUT_APPLY=false',
      'KEEL_INPUT_REGION=west',
    ]),
  );

  expect(taskInspection.HostConfig.LogConfig.Type).toBe('none');
  await mutate((tx) => control.transition(tx, p, cancelledTask.id, 'cancel', true));
  await waitResult(cancelledTask, 'CANCELLED');
  expect(await applicationID()).toBe(retainedApplication);

  const interruptedTask = await runbook(hook('sleep 60', 10));
  const interruptedName = await waitHook(interruptedTask, 'runbook');

  await stopAgent();

  await until(
    async () =>
      (
        await run('docker', [
          'container',
          'inspect',
          '--format',
          '{{.State.Running}}',
          interruptedName,
        ])
      ).stdout.trim() === 'false',
    15000,
  );

  await db.query(
    "UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE deployment_id=$1",
    [interruptedTask.id],
  );

  await execution.tick(f.org, interruptedTask.id);
  startAgent();
  await waitResult(interruptedTask, 'RECONCILED');
  expect(await applicationID()).toBe(retainedApplication);

  expect(
    (
      await db.query(
        'SELECT count(*)::int AS count FROM deployment_attempts WHERE deployment_id=$1',
        [interruptedTask.id],
      )
    ).rows[0].count,
  ).toBe(1);

  for (const target of targets) {
    expect(
      (
        await run('docker', [
          'container',
          'ls',
          '--all',
          '--filter',
          `name=keel-target-${target}-hook-`,
          '--format',
          '{{.Names}} {{.Status}}',
        ])
      ).stdout.trim(),
    ).toBe('');
  }

  expect(output).not.toContain(secret);
  expect(output).not.toContain('not-for-hooks');
}, 150000);
