import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { backup, restore, validateBackup } from './backup.js';
import { readKey } from './archive.js';
import { compose, exists, initialize, readInstallation } from './installation.js';
import { up, stop, status } from './lifecycle.js';

const help = `Keel self-hosted operations

  npm run self-host -- init --directory <new-directory> --project keel-main --hostname <dns-name>
  npm run self-host -- build --directory <directory>
  npm run self-host -- up --directory <directory>
  npm run self-host -- status --directory <directory>
  npm run self-host -- verify --directory <directory>
  npm run self-host -- stop --directory <directory>
  npm run self-host -- keygen --key-file <new-key-file>
  npm run self-host -- backup --directory <directory> --output <new-backup-directory> --key-file <key-file>
  npm run self-host -- verify-backup --backup <backup-directory> --key-file <key-file>
  npm run self-host -- restore --backup <backup-directory> --directory <new-directory> --project keel-restored --key-file <key-file>

Init options: --https-port 8443 --agent-port 8444 --bind 127.0.0.1 --image-tag 0.1.0
Stop requires completed deployments and reconciliation. Backups require all services stopped.
Restore uses fresh volumes, checks retained bytes and keys, and revokes agent access before startup.
Keep the backup key outside the installation and retain the exact container images.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      directory: { type: 'string' },
      project: { type: 'string' },
      hostname: { type: 'string' },
      'https-port': { type: 'string' },
      'agent-port': { type: 'string' },
      bind: { type: 'string' },
      'image-tag': { type: 'string' },
      'key-file': { type: 'string' },
      output: { type: 'string' },
      backup: { type: 'string' },
    },
  });

  const command = positionals[0];

  const required = (name: keyof typeof values) => {
    const value = values[name];

    if (typeof value !== 'string' || !value) {
      throw new Error(`Provide --${name}.`);
    }

    return value;
  };

  if (values.help || !command) {
    console.log(help);
  } else if (positionals.length !== 1) {
    throw new Error('Provide one operations command.');
  } else if (command === 'keygen') {
    await writeFile(resolve(required('key-file')), randomBytes(32).toString('base64') + '\n', {
      mode: 0o600,
      flag: 'wx',
    });

    console.log('Backup key created. Store a separate offline copy.');
  } else if (command === 'verify-backup') {
    const key = await readKey(resolve(required('key-file')));

    try {
      const manifest = await validateBackup(resolve(required('backup')), key);

      console.log(
        JSON.stringify({
          valid: true,
          createdAt: manifest.createdAt,
          components: Object.keys(manifest.checksums),
        }),
      );
    } finally {
      key.fill(0);
    }
  } else {
    const directory = resolve(required('directory'));

    if (command === 'init') {
      await initialize(directory, {
        format: 1,
        project: required('project'),
        hostname: values.hostname || 'localhost',
        bind: (values.bind || '127.0.0.1') as '127.0.0.1',
        httpsPort: Number(values['https-port'] || 8443),
        agentPort: Number(values['agent-port'] || 8444),
        imageTag: values['image-tag'] || '0.1.0',
      });

      console.log(
        'Installation created. Trust tls/ca.crt for private HTTPS. Bootstrap tokens are in secrets/. Read docs/self-hosting.md before exposing the service.',
      );
    } else if (command === 'restore') {
      console.log(
        JSON.stringify(
          await restore(
            resolve(required('backup')),
            directory,
            resolve(required('key-file')),
            required('project'),
          ),
        ),
      );
    } else {
      const installation = await readInstallation(directory);
      const lock = join(directory, '.operation-lock');

      await mkdir(lock, { mode: 0o700 });

      try {
        if (await exists(join(directory, 'recovery-pending'))) {
          throw new Error(
            'Restore is incomplete. Do not start this installation; consult the recovery guide.',
          );
        }

        switch (command) {
          case 'build':
            console.log(await compose(directory, installation, ['build', 'api']));
            break;
          case 'up':
            await up(directory, installation);

            console.log(
              `Keel is ready at https://${installation.hostname}:${installation.httpsPort}.`,
            );

            break;
          case 'status':
            console.log(JSON.stringify(await status(directory, installation)));
            break;
          case 'verify':
            console.log(
              await compose(directory, installation, [
                'run',
                '--rm',
                '--no-deps',
                'operations',
                'verify',
              ]),
            );

            break;
          case 'stop':
            await stop(directory, installation);
            console.log('Installation stopped cleanly. It is ready for backup.');
            break;
          case 'backup':
            await backup(
              directory,
              installation,
              resolve(required('output')),
              resolve(required('key-file')),
            );

            console.log('Encrypted backup complete. Services remain stopped; run up to resume.');
            break;
          default:
            throw new Error('Unknown operations command. Run with --help.');
        }
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Self-hosted operation failed.');
  process.exitCode = 1;
}
