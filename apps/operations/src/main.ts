import { readFile } from 'node:fs/promises';
import { database } from '../../../packages/database/src/index.js';
import { migrate } from '../../../packages/database/src/migrate.js';
import { bootstrap } from '../../../packages/database/src/bootstrap.js';
import { configure } from './configuration.js';
import { verify, quiescent, quarantine } from './recovery.js';
import { health } from './health.js';
import { OperationError } from './operation-error.js';

const services = [
  'api',
  'artifact-worker',
  'notification-worker',
  'workflow-worker',
  'agent-gateway',
];

const tasks = ['provision', 'migrate', 'verify', 'quiescent', 'quarantine', 'health'];
const command = process.argv[2];

try {
  await configure();

  if (services.includes(command)) {
    const entry = command === 'api' ? 'server' : 'main';

    await import(new URL(`../../${command}/dist/${entry}.js`, import.meta.url).href);
  } else {
    const db = database(process.env.DATABASE_URL!);

    try {
      switch (command) {
        case 'provision': {
          // The superuser is confined to this one-shot provisioning process.
          for (const role of ['keel_owner', 'keel_runtime', 'temporal']) {
            const password = (await readFile(`/run/secrets/${role}_password`, 'utf8')).trim();

            if (!/^[a-f0-9]{64}$/.test(password)) {
              throw new OperationError('Invalid database password file.');
            }

            const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);

            // Names and password alphabet are fixed above; PostgreSQL role DDL has no parameters.
            await db.query(
              `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
            );
          }

          for (const [name, owner] of [
            ['keel', 'keel_owner'],
            ['temporal', 'temporal'],
            ['temporal_visibility', 'temporal'],
          ]) {
            const exists = await db.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);

            if (!exists.rowCount) {
              await db.query(`CREATE DATABASE ${name} OWNER ${owner}`);
            }

            await db.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
          }

          await db.query('GRANT CONNECT ON DATABASE keel TO keel_runtime');
          break;
        }

        case 'migrate':
          await migrate(db, new URL('../../../packages/database/migrations/', import.meta.url));
          await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
          await db.query('GRANT USAGE ON SCHEMA public TO keel_runtime');

          await db.query(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO keel_runtime',
          );

          await db.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO keel_runtime');

          await bootstrap(
            db,
            process.env,
            process.env.KEEL_WORKSPACE_NAME || 'Self-hosted workspace',
          );

          break;
        case 'verify':
          console.log(JSON.stringify(await verify(db)));
          break;
        case 'quiescent':
          console.log(JSON.stringify(await quiescent(db)));
          break;
        case 'quarantine':
          console.log(JSON.stringify(await quarantine(db)));
          break;
        case 'health':
          await health(db, process.argv[3]);
          break;
        default:
          throw new OperationError('Unknown operations command.');
      }
    } finally {
      await db.end();
    }
  }
} catch (error) {
  // Driver errors can contain connection strings, so only Keel's own messages and error codes such
  // as ECONNREFUSED or 28P01 are printed.
  const known = [...services, ...tasks].includes(command) ? command : 'unknown';
  const code = (error as { code?: unknown } | null)?.code;
  let reason = '';

  if (error instanceof OperationError) {
    reason = ` ${error.message}`;
  } else if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) {
    reason = ` Error code ${code}.`;
  }

  console.error(
    `Keel operations command failed: ${known}.${reason} Check configuration, service health and the recovery guide.`,
  );

  process.exitCode = 1;
}
