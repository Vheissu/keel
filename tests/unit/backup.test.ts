import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { encrypt, decrypt, readKey, verifyEncrypted } from '../../scripts/self-host/archive.js';
import { configure } from '../../apps/operations/src/configuration.js';
import { installationSchema } from '../../scripts/self-host/installation.js';

const directories: string[] = [];

async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'keel-backup-test-'));

  directories.push(result);

  return result;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('encrypts a streamed backup without disclosing plaintext and rejects altered data, wrong keys and component substitution', async () => {
  const root = await directory();
  const file = join(root, 'backup.enc');
  const key = randomBytes(32);
  const plaintext = Buffer.from('private database password and artifact bytes'.repeat(10000));

  await encrypt(
    Readable.from([plaintext.subarray(0, 500), plaintext.subarray(500)]),
    file,
    key,
    'postgres',
  );

  const encrypted = await readFile(file);

  expect(encrypted.includes(plaintext.subarray(0, 50))).toBe(false);
  await verifyEncrypted(file, key, 'postgres');
  const output: Buffer[] = [];

  await decrypt(
    file,
    key,
    'postgres',
    new Writable({
      write(chunk, _encoding, done) {
        output.push(Buffer.from(chunk));
        done();
      },
    }),
  );

  expect(Buffer.concat(output)).toEqual(plaintext);
  await expect(verifyEncrypted(file, randomBytes(32), 'postgres')).rejects.toThrow();
  await expect(verifyEncrypted(file, key, 'artifacts')).rejects.toThrow();
  encrypted[50] ^= 1;
  await writeFile(file, encrypted);
  await expect(verifyEncrypted(file, key, 'postgres')).rejects.toThrow();
  await writeFile(file, encrypted.subarray(0, 20));
  await expect(verifyEncrypted(file, key, 'postgres')).rejects.toThrow('Truncated');
});

it('requires a canonical full-length backup key', async () => {
  const file = join(await directory(), 'key');
  const key = randomBytes(32);

  await writeFile(file, key.toString('base64') + '\n');
  expect(await readKey(file)).toEqual(key);

  for (const value of [
    '',
    'password',
    randomBytes(31).toString('base64'),
    key.toString('base64') + '!',
  ]) {
    await writeFile(file, value);
    await expect(readKey(file)).rejects.toThrow('32-byte');
  }
});

it('loads only declared runtime secrets and rejects ambiguous configuration', async () => {
  const file = join(await directory(), 'password');

  await writeFile(file, 'private:password\n');

  const env: NodeJS.ProcessEnv = {
    DB_USER: 'keel_runtime',
    DB_PASSWORD_FILE: file,
    UNRELATED_FILE: '/missing',
  };

  await configure(env);
  expect(new URL(env.DATABASE_URL!).password).toBe('private%3Apassword');
  expect(env.UNRELATED).toBeUndefined();
  await expect(configure(env)).rejects.toThrow('not both');
  await writeFile(file, '\n');

  await expect(configure({ DB_USER: 'keel_runtime', DB_PASSWORD_FILE: file })).rejects.toThrow(
    'empty',
  );
});

it('rejects unsafe installation names, hostnames, bind addresses and ports', () => {
  const installation = {
    format: 1,
    project: 'keel-main',
    hostname: 'keel.example.com',
    bind: '127.0.0.1',
    httpsPort: 8443,
    agentPort: 8444,
    imageTag: '0.1.0',
  };

  expect(installationSchema.safeParse(installation).success).toBe(true);

  for (const change of [
    { project: '../other' },
    { hostname: 'host\nsubjectAltName=DNS:other' },
    { bind: '$(command)' },
    { httpsPort: 8444 },
    { httpsPort: 0 },
    { imageTag: '../../other' },
  ]) {
    expect(installationSchema.safeParse({ ...installation, ...change }).success).toBe(false);
  }
});
