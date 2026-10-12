import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { compose, type Installation } from './installation.js';

export const services = [
  'api',
  'artifact-worker',
  'notification-worker',
  'workflow-worker',
  'agent-gateway',
];

export async function up(directory: string, installation: Installation) {
  const running = (
    await compose(directory, installation, ['ps', '--status', 'running', '--services'])
  )
    .trim()
    .split('\n');

  if (services.some((service) => running.includes(service))) {
    throw new Error(
      'Application services are already running. Use status, or stop cleanly before upgrading.',
    );
  }

  await rm(join(directory, 'stopped.json'), { force: true });
  await compose(directory, installation, ['up', '-d', '--wait', 'postgres']);
  await compose(directory, installation, ['run', '--rm', '--no-deps', 'volumes']);
  await compose(directory, installation, ['run', '--rm', '--no-deps', 'provision']);
  await compose(directory, installation, ['run', '--rm', '--no-deps', 'migrate']);
  await compose(directory, installation, ['run', '--rm', '--no-deps', 'temporal-schema']);
  await compose(directory, installation, ['up', '-d', '--wait', 'temporal']);
  await compose(directory, installation, ['run', '--rm', '--no-deps', 'temporal-namespace']);
  await compose(directory, installation, ['up', '-d', '--wait', ...services]);
}

export async function stop(directory: string, installation: Installation) {
  // Close admission before checking for work. Existing agents can still finish through the gateway.
  await compose(directory, installation, ['stop', 'api', 'artifact-worker', 'notification-worker']);

  try {
    await compose(directory, installation, ['run', '--rm', '--no-deps', 'operations', 'quiescent']);
  } catch (error) {
    await compose(directory, installation, [
      'start',
      'api',
      'artifact-worker',
      'notification-worker',
    ]);

    // The check also fails when PostgreSQL is unavailable, so pass on its own reason.
    const reason =
      (error instanceof Error ? error.message : '').match(
        /Keel operations command failed: .*/,
      )?.[0] ?? 'The quiescence check did not complete.';

    throw new Error(
      `Active work, reconciliation or a failed check prevents a clean stop. Admission has resumed. ${reason}`,
    );
  }

  await compose(directory, installation, [
    'stop',
    'workflow-worker',
    'agent-gateway',
    'temporal',
    'postgres',
  ]);

  await writeFile(
    join(directory, 'stopped.json'),
    JSON.stringify({ stoppedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
}

export async function status(directory: string, installation: Installation) {
  const raw = (await compose(directory, installation, ['ps', '--all', '--format', 'json'])).trim();

  const rows = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));

  const entries = Array.isArray(rows) ? rows : [rows];

  const result = entries.map((row) => ({
    service: row.Service,
    state: row.State,
    health: row.Health || null,
  }));

  for (const name of ['postgres', 'temporal', ...services]) {
    const entry = result.find((row) => row.service === name);

    if (!entry || entry.state !== 'running' || entry.health !== 'healthy') {
      console.log(JSON.stringify(result));
      throw new Error(`${name} is not healthy.`);
    }
  }

  return result;
}
