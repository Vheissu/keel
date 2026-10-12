import { readFile } from 'node:fs/promises';
import { OperationError } from './operation-error.js';

export const secretNames = [
  'DB_PASSWORD',
  'KEEL_CREDENTIAL_KEY',
  'KEEL_DEPLOYMENT_SECRET_KEY',
  'KEEL_OPERATOR_TOKEN',
  'KEEL_APPROVER_TOKEN',
  'KEEL_SECRET_MANAGER_TOKEN',
] as const;

export async function configure(env = process.env) {
  for (const name of secretNames) {
    const file = env[`${name}_FILE`];

    if (!file) {
      continue;
    }

    if (env[name]) {
      throw new OperationError(`Configure ${name} or ${name}_FILE, not both.`);
    }

    const value = (await readFile(file, 'utf8')).trim();

    if (!value) {
      throw new OperationError(`${name}_FILE is empty.`);
    }

    env[name] = value;
  }

  if (!env.DATABASE_URL) {
    if (!env.DB_USER || !env.DB_PASSWORD) {
      throw new OperationError('Database credentials are missing.');
    }

    const url = new URL('postgres://postgres:5432/keel');

    url.pathname = `/${env.DB_NAME || 'keel'}`;
    url.username = env.DB_USER;
    url.password = env.DB_PASSWORD;
    env.DATABASE_URL = url.href;
  }
}
