import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { database } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { bootstrap } from '../packages/database/src/bootstrap.js';

let source: string;

try {
  source = await readFile('.env', 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }

  source = (await readFile('.env.example', 'utf8'))
    .replace('KEEL_OPERATOR_TOKEN=', `KEEL_OPERATOR_TOKEN=keel_${randomBytes(32).toString('hex')}`)
    .replace('KEEL_APPROVER_TOKEN=', `KEEL_APPROVER_TOKEN=keel_${randomBytes(32).toString('hex')}`);

  await writeFile('.env', source, { mode: 0o600, flag: 'wx' });
}

const env = parse(source);

if (!env.KEEL_CREDENTIAL_KEY) {
  env.KEEL_CREDENTIAL_KEY = randomBytes(32).toString('base64');
  source = source.replace(/^KEEL_CREDENTIAL_KEY=.*$/m, '');
  source += `\nKEEL_CREDENTIAL_KEY=${env.KEEL_CREDENTIAL_KEY}\n`;
  await writeFile('.env', source, { mode: 0o600 });
}

for (const name of ['KEEL_DEPLOYMENT_SECRET_KEY', 'KEEL_SECRET_MANAGER_TOKEN']) {
  if (!env[name]) {
    env[name] =
      name === 'KEEL_SECRET_MANAGER_TOKEN'
        ? `keel_${randomBytes(32).toString('hex')}`
        : randomBytes(32).toString('base64');

    source = source.replace(new RegExp(`^${name}=.*$`, 'm'), '');
    source += `\n${name}=${env[name]}\n`;
    await writeFile('.env', source, { mode: 0o600 });
  }
}

if (
  !env.KEEL_OPERATOR_TOKEN ||
  !env.KEEL_APPROVER_TOKEN ||
  new Set([env.KEEL_OPERATOR_TOKEN, env.KEEL_APPROVER_TOKEN, env.KEEL_SECRET_MANAGER_TOKEN])
    .size !== 3
) {
  throw new Error('Set distinct operator, approver and secret-manager tokens in .env.');
}

const docker = spawnSync(
  'docker',
  ['compose', '-f', 'infrastructure/docker/compose.yml', 'up', '-d', '--wait'],
  { stdio: 'inherit' },
);

if (docker.status !== 0) {
  throw new Error('Could not start PostgreSQL. Start Docker and run setup again.');
}

const db = database(env.DATABASE_URL);

try {
  await migrate(db);

  await bootstrap(db, env);

  console.log(
    'Keel is ready. Run npm run dev, open http://127.0.0.1:5173, and connect with KEEL_OPERATOR_TOKEN from .env. Use KEEL_APPROVER_TOKEN in a separate session to approve production requests, or KEEL_SECRET_MANAGER_TOKEN to manage deployment secrets.',
  );
} finally {
  await db.end();
}
