import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod, access, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { run } from './process.js';

export const repository = fileURLToPath(new URL('../../', import.meta.url));

export const composeFile = join(repository, 'infrastructure/self-host/compose.yml');

export const installationSchema = z
  .object({
    format: z.literal(1),
    project: z.string().regex(/^keel-[a-z0-9][a-z0-9-]{0,34}$/),
    hostname: z
      .string()
      .max(253)
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
    bind: z.enum(['127.0.0.1', '0.0.0.0']),
    httpsPort: z.number().int().min(1024).max(65535),
    agentPort: z.number().int().min(1024).max(65535),
    publicUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);

        return url.protocol === 'https:' && url.origin === value;
      }, 'Use an HTTPS origin without a path.')
      .optional(),
    imageTag: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/),
  })
  .strict()
  .refine((value) => value.httpsPort !== value.agentPort, 'Choose distinct ports.');

export type Installation = z.infer<typeof installationSchema>;

export async function exists(path: string) {
  try {
    await access(path);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function readInstallation(directory: string) {
  return installationSchema.parse(
    JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8')),
  );
}

export function environment(directory: string, installation: Installation) {
  return {
    ...process.env,
    KEEL_INSTANCE_DIR: resolve(directory),
    KEEL_PUBLIC_URL: installation.publicUrl || '',
    KEEL_BIND_ADDRESS: installation.bind,
    KEEL_HOSTNAME: installation.hostname,
    KEEL_HTTPS_PORT: String(installation.httpsPort),
    KEEL_AGENT_PORT: String(installation.agentPort),
    KEEL_IMAGE_TAG: installation.imageTag,
  };
}

export function composeArgs(installation: Installation, args: string[]) {
  return ['compose', '-p', installation.project, '-f', composeFile, ...args];
}

export async function compose(directory: string, installation: Installation, args: string[]) {
  return run('docker', composeArgs(installation, args), environment(directory, installation));
}

export async function initialize(directory: string, installation: Installation) {
  installation = installationSchema.parse(installation);

  if (await exists(directory)) {
    throw new Error('Installation directory already exists. Initialization never replaces keys.');
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(join(directory, 'secrets'), { mode: 0o700 });
  await mkdir(join(directory, 'tls'), { mode: 0o700 });

  for (const name of [
    'postgres_password',
    'keel_owner_password',
    'keel_runtime_password',
    'temporal_password',
    'operator_token',
    'approver_token',
    'secret_manager_token',
    'credential_key',
    'deployment_secret_key',
  ]) {
    const value = randomBytes(32).toString(name.endsWith('_key') ? 'base64' : 'hex');

    // Parent directories are 0700. Read-only files also work with Compose bind-mounted secrets
    // when the host user ID differs from the unprivileged container user.
    await writeFile(join(directory, 'secrets', name), value + '\n', { mode: 0o444, flag: 'wx' });
  }

  const tls = join(directory, 'tls');

  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-keyout',
    join(tls, 'ca.key'),
    '-out',
    join(tls, 'ca.crt'),
    '-days',
    '3650',
    '-subj',
    '/CN=Keel installation CA',
  ]);

  await chmod(join(tls, 'ca.key'), 0o600);

  for (const identity of ['server', 'agent']) {
    await run('openssl', [
      'req',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-keyout',
      join(tls, `${identity}.key`),
      '-out',
      join(tls, `${identity}.csr`),
      '-subj',
      `/CN=Keel ${identity}`,
    ]);

    const extensions =
      identity === 'server'
        ? `subjectAltName=DNS:${installation.hostname},DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n`
        : 'extendedKeyUsage=clientAuth\n';

    await writeFile(join(tls, `${identity}.ext`), extensions, { mode: 0o600 });

    await run('openssl', [
      'x509',
      '-req',
      '-in',
      join(tls, `${identity}.csr`),
      '-CA',
      join(tls, 'ca.crt'),
      '-CAkey',
      join(tls, 'ca.key'),
      '-CAcreateserial',
      '-out',
      join(tls, `${identity}.crt`),
      '-days',
      '365',
      '-extfile',
      join(tls, `${identity}.ext`),
    ]);

    await chmod(join(tls, `${identity}.key`), identity === 'server' ? 0o444 : 0o600);
    await rm(join(tls, `${identity}.csr`));
    await rm(join(tls, `${identity}.ext`));
  }

  await writeFile(
    join(directory, 'installation.json'),
    JSON.stringify(installation, null, 2) + '\n',
    { mode: 0o600 },
  );
}
