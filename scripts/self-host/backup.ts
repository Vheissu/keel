import { join, resolve, relative } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { encrypt, decrypt, readKey, hashFile, readManifest, verifyEncrypted } from './archive.js';
import { compose, exists, readInstallation, type Installation } from './installation.js';
import { start, run } from './process.js';

const components = ['configuration', 'postgres', 'artifacts'] as const;

// Each image is checked against the container of the service that ran it.
const images = [
  { name: 'keel/self-host:', service: 'api' },
  { name: 'postgres:17.11-alpine', service: 'postgres' },
  { name: 'temporalio/server:1.31.0', service: 'temporal' },
];

const manifestSchema = z
  .object({
    format: z.literal(1),
    createdAt: z.string(),
    project: z.string(),
    images: z
      .array(z.object({ name: z.string(), id: z.string().regex(/^sha256:[a-f0-9]{64}$/) }))
      .length(3),
    checksums: z
      .object({ configuration: z.string(), postgres: z.string(), artifacts: z.string() })
      .strict(),
  })
  .strict();

async function usedImages(directory: string, installation: Installation) {
  return Promise.all(
    images.map(async (image) => {
      const name = image.name.endsWith(':') ? `${image.name}${installation.imageTag}` : image.name;
      const id = (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', name])).trim();

      const container = (
        await compose(directory, installation, ['ps', '--all', '-q', image.service])
      ).trim();

      const used = (await run('docker', ['inspect', '--format', '{{.Image}}', container])).trim();

      if (id !== used) {
        throw new Error(
          `Image tag changed since this installation ran: ${name}. Restore the original tag before backup.`,
        );
      }

      return { name, id };
    }),
  );
}

async function stopped(directory: string, installation: Installation) {
  if (!(await exists(join(directory, 'stopped.json')))) {
    throw new Error('Run stop successfully before creating a backup.');
  }

  const running = (
    await compose(directory, installation, ['ps', '--status', 'running', '-q'])
  ).trim();

  if (running) {
    throw new Error('Every installation service must be stopped during backup.');
  }
}

export async function backup(
  directory: string,
  installation: Installation,
  destination: string,
  keyFile: string,
) {
  await stopped(directory, installation);

  if (await exists(destination)) {
    throw new Error('Backup destination already exists.');
  }

  const keyLocation = relative(resolve(directory), resolve(keyFile));

  if (keyLocation !== '..' && !keyLocation.startsWith('../')) {
    throw new Error('Keep the backup key outside the installation directory.');
  }

  const key = await readKey(keyFile);
  const retainedImages = await usedImages(directory, installation);
  const checksums: Record<string, string> = {};

  await mkdir(destination, { recursive: true, mode: 0o700 });

  try {
    for (const name of components) {
      const file = join(destination, `${name}.enc`);

      const args =
        name === 'configuration'
          ? ['-C', resolve(directory), '-czf', '-', 'installation.json', 'secrets', 'tls']
          : [
              'run',
              '--rm',
              '--network',
              'none',
              '--read-only',
              '-v',
              `${installation.project}_${name}:/source:ro`,
              'busybox:1.37.0',
              'tar',
              '-C',
              '/source',
              '-czf',
              '-',
              '.',
            ];

      const { child, done } = start(name === 'configuration' ? 'tar' : 'docker', args);

      child.stdin.end();

      try {
        await Promise.all([encrypt(child.stdout, file, key, name), done]);
      } finally {
        child.kill();
      }

      checksums[name] = await hashFile(file);
    }

    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      project: installation.project,
      images: retainedImages,
      checksums,
    };

    await encrypt(
      Readable.from([JSON.stringify(manifest)]),
      join(destination, 'manifest.enc'),
      key,
      'manifest',
    );
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

export async function validateBackup(source: string, key: Buffer) {
  const manifest = manifestSchema.parse(await readManifest(join(source, 'manifest.enc'), key));

  for (const name of components) {
    const file = join(source, `${name}.enc`);

    if ((await hashFile(file)) !== manifest.checksums[name]) {
      throw new Error(`Backup checksum failed: ${name}.`);
    }

    await verifyEncrypted(file, key, name);
  }

  return manifest;
}

export async function restore(
  source: string,
  destination: string,
  keyFile: string,
  project: string,
) {
  if (!/^keel-[a-z0-9][a-z0-9-]{0,34}$/.test(project) || (await exists(destination))) {
    throw new Error(
      'Restore requires a new installation directory and a valid keel- project name.',
    );
  }

  const containers = (
    await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])
  ).trim();

  if (containers) {
    throw new Error('Restore requires a project with no existing containers.');
  }

  const volumes = (await run('docker', ['volume', 'ls', '--format', '{{.Name}}']))
    .trim()
    .split('\n');

  if (['postgres', 'artifacts'].some((name) => volumes.includes(`${project}_${name}`))) {
    throw new Error('Restore refuses to overwrite existing volumes. Choose a fresh project name.');
  }

  const key = await readKey(keyFile);

  try {
    const manifest = await validateBackup(source, key);

    // All ciphertext is authenticated before creating anything or invoking an extractor.
    for (const image of manifest.images) {
      const id = (
        await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image.name])
      ).trim();

      if (id !== image.id) {
        throw new Error(
          `Restore needs the original image: ${image.name}. Load the saved image before restoring.`,
        );
      }
    }

    await mkdir(destination, { recursive: true, mode: 0o700 });

    await writeFile(
      join(destination, 'recovery-pending'),
      'Restore must finish verification and agent quarantine before startup.\n',
      { mode: 0o600 },
    );

    for (const name of components) {
      const args =
        name === 'configuration'
          ? ['-C', resolve(destination), '-xzf', '-']
          : [
              'run',
              '--rm',
              '-i',
              '--network',
              'none',
              '--read-only',
              '-v',
              `${project}_${name}:/destination`,
              'busybox:1.37.0',
              'tar',
              '-C',
              '/destination',
              '-xzf',
              '-',
            ];

      const { child, done } = start(name === 'configuration' ? 'tar' : 'docker', args);

      child.stdout.resume();

      try {
        await Promise.all([decrypt(join(source, `${name}.enc`), key, name, child.stdin), done]);
      } finally {
        child.kill();
      }
    }

    const installation = await readInstallation(destination);

    installation.project = project;

    await writeFile(
      join(destination, 'installation.json'),
      JSON.stringify(installation, null, 2) + '\n',
      { mode: 0o600 },
    );

    await compose(destination, installation, ['up', '-d', '--wait', 'postgres']);
    await compose(destination, installation, ['run', '--rm', '--no-deps', 'operations', 'verify']);

    await compose(destination, installation, [
      'run',
      '--rm',
      '--no-deps',
      'operations',
      'quarantine',
    ]);

    await compose(destination, installation, ['stop', 'postgres']);
    await rm(join(destination, 'recovery-pending'));

    await writeFile(
      join(destination, 'stopped.json'),
      JSON.stringify({ restoredAt: new Date().toISOString() }),
      { mode: 0o600 },
    );

    return { project, restoredAt: manifest.createdAt, agents: 'revoked', targets: 'unknown' };
  } finally {
    key.fill(0);
  }
}
