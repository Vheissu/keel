import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { database, transaction } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { sha256 } from '../apps/api/src/artifact-store.js';

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

if (
  !env.KEEL_OPERATOR_TOKEN ||
  !env.KEEL_APPROVER_TOKEN ||
  env.KEEL_OPERATOR_TOKEN === env.KEEL_APPROVER_TOKEN
) {
  throw new Error('Set distinct operator and approver tokens in .env.');
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

  await transaction(db, async (tx) => {
    const org = '00000000-0000-4000-8000-000000000001';

    await tx.query('INSERT INTO organisations(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      org,
      'Local workspace',
    ]);

    for (const [id, label, token, permissions] of [
      [
        '00000000-0000-4000-8000-000000000002',
        'Local operator',
        env.KEEL_OPERATOR_TOKEN,
        ['read', 'write'],
      ],
      [
        '00000000-0000-4000-8000-000000000003',
        'Local approver',
        env.KEEL_APPROVER_TOKEN,
        ['read', 'approve'],
      ],
    ] as const) {
      await tx.query(
        `
          INSERT INTO
            actors (id, organisation_id, name)
          VALUES
            ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `,
        [id, org, label],
      );

      // Changing a local bootstrap token revokes the previous one for that actor.
      await tx.query(
        `
          UPDATE api_tokens
          SET
            revoked_at = now()
          WHERE
            actor_id = $1
            AND token_hash <> $2
            AND revoked_at IS NULL
        `,
        [id, sha256(token)],
      );

      const inserted = await tx.query(
        `
          INSERT INTO
            api_tokens (
              id,
              organisation_id,
              actor_id,
              token_hash,
              permissions
            )
          VALUES
            ($1, $2, $3, $4, $5)
          ON CONFLICT (token_hash) DO UPDATE
          SET
            revoked_at = NULL,
            permissions = EXCLUDED.permissions
          WHERE
            api_tokens.actor_id = EXCLUDED.actor_id
        `,
        [randomUUID(), org, id, sha256(token), permissions],
      );

      // Reusing a previous token restores it; a token held by another actor is rejected.
      if (!inserted.rowCount) {
        throw new Error(`The ${label} token in .env belongs to another identity.`);
      }
    }

    for (const [label, slug, approval] of [
      ['Staging', 'staging', false],
      ['Production', 'production', true],
    ] as const) {
      await tx.query(
        `
          INSERT INTO
            environments (
              id,
              organisation_id,
              name,
              slug,
              requires_approval,
              promotion_from_environment_id
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              CASE
                WHEN $4 = 'production' THEN (
                  SELECT
                    id
                  FROM
                    environments
                  WHERE
                    organisation_id = $2
                    AND slug = 'staging'
                )
                ELSE NULL
              END
            )
          ON CONFLICT (organisation_id, slug) DO NOTHING
        `,
        [randomUUID(), org, label, slug, approval],
      );
    }
  });

  console.log(
    'Keel is ready. Run npm run dev, open http://127.0.0.1:5173, and connect with KEEL_OPERATOR_TOKEN from .env. Use KEEL_APPROVER_TOKEN in a separate session to approve production requests.',
  );
} finally {
  await db.end();
}
