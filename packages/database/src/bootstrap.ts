import { createHash, randomUUID } from 'node:crypto';
import { transaction, type Database } from './index.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function bootstrap(
  db: Database,
  env: Record<string, string | undefined>,
  workspaceName = 'Local workspace',
) {
  const tokens = ['KEEL_OPERATOR_TOKEN', 'KEEL_APPROVER_TOKEN', 'KEEL_SECRET_MANAGER_TOKEN'].map(
    (name) => env[name],
  );

  if (tokens.some((token) => !token) || new Set(tokens).size !== 3) {
    throw new Error('Set three distinct bootstrap tokens.');
  }

  await transaction(db, async (tx) => {
    const org = '00000000-0000-4000-8000-000000000001';

    await tx.query('INSERT INTO organisations(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      org,
      workspaceName,
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
      [
        '00000000-0000-4000-8000-000000000004',
        'Local secret manager',
        env.KEEL_SECRET_MANAGER_TOKEN,
        ['read', 'manage_secrets'],
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
        [id, sha256(token!)],
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
        [randomUUID(), org, id, sha256(token!), permissions],
      );

      // Reusing a previous token restores it; a token held by another actor is rejected.
      if (!inserted.rowCount) {
        throw new Error(`The ${label} token belongs to another identity.`);
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
}
