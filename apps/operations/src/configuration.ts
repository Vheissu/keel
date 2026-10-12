import { readFile } from 'node:fs/promises';

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
      throw new Error(`Configure ${name} or ${name}_FILE, not both.`);
    }

    const value = (await readFile(file, 'utf8')).trim();

    if (!value) {
      throw new Error(`${name}_FILE is empty.`);
    }

    env[name] = value;
  }

  if (!env.DATABASE_URL) {
    if (!env.DB_USER || !env.DB_PASSWORD) {
      throw new Error('Database credentials are missing.');
    }

    const url = new URL('postgres://postgres:5432/keel');

    url.pathname = `/${env.DB_NAME || 'keel'}`;
    url.username = env.DB_USER;
    url.password = env.DB_PASSWORD;
    env.DATABASE_URL = url.href;
  }
}
