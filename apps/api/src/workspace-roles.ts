import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Transaction } from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { Identity, tokenInput } from './identity.js';
import { rolePermissions } from './identity-policy.js';
import { sha256 } from './artifact-store.js';

const definition = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(
        (name) => !Object.hasOwn(rolePermissions, name.toLowerCase()),
        'Choose a name different from a built-in role.',
      ),
    permissions: tokenInput.shape.permissions,
  })
  .strict();

export async function registerWorkspaceRoles(api: FastifyInstance, identity: Identity) {
  const { control } = identity;

  const mutate = <T>(req: FastifyRequest, work: (tx: Transaction) => Promise<T>) => {
    identity.admin(req.principal, true);

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] || ''),
      sha256(`${req.method}:${req.url}:${JSON.stringify(req.body)}`),
      work,
    );
  };

  api.get('/identity/roles', async (req) => {
    if (!req.principal.session_id) {
      throw new DomainError('FORBIDDEN', 'Sign in to view workspace roles.', 403);
    }

    const custom = await control.db.query(
      `
        SELECT
          id,
          name,
          permissions,
          revision
        FROM
          workspace_roles
        WHERE
          organisation_id = $1
          AND archived_at IS NULL
        ORDER BY
          lower(name),
          id
      `,
      [req.principal.organisation_id],
    );

    return {
      items: [
        ...Object.entries(rolePermissions).map(([id, permissions]) => ({
          id,
          name: id,
          permissions,
          builtin: true,
        })),
        ...custom.rows.map((role) => ({ ...role, builtin: false })),
      ],
    };
  });

  api.post('/identity/roles', async (req) => {
    const input = definition.parse(req.body);

    return mutate(req, async (tx) => {
      const count = await tx.query(
        'SELECT count(*) FROM workspace_roles WHERE organisation_id=$1 AND archived_at IS NULL',
        [req.principal.organisation_id],
      );

      if (Number(count.rows[0].count) >= 100) {
        throw new DomainError(
          'ROLE_LIMIT',
          'Archive an unused role before creating another. Workspaces support 100 custom roles.',
          409,
        );
      }

      const result = await tx.query(
        `
          INSERT INTO
            workspace_roles (id, organisation_id, name, permissions)
          VALUES
            ($1, $2, $3, $4)
          RETURNING
            id,
            name,
            permissions,
            revision
        `,
        [randomUUID(), req.principal.organisation_id, input.name, input.permissions],
      );

      await control.audit(tx, req.principal, 'workspace_role.created', result.rows[0].id, input);

      return result.rows[0];
    });
  });

  for (const action of ['update', 'archive'] as const) {
    api.post<{ Params: { id: string } }>(`/identity/roles/:id/${action}`, async (req) => {
      const id = z.string().uuid().parse(req.params.id);
      const revision = z.object({ expected_revision: z.number().int().positive() });

      const input = (action === 'update' ? definition.merge(revision) : revision)
        .strict()
        .parse(req.body);

      return mutate(req, async (tx) => {
        const role = (
          await tx.query(
            'SELECT * FROM workspace_roles WHERE organisation_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE',
            [req.principal.organisation_id, id],
          )
        ).rows[0];

        if (!role) {
          throw new DomainError('NOT_FOUND', 'Active custom role not found.', 404);
        }

        if (role.revision !== input.expected_revision) {
          throw new DomainError(
            'REVISION_CONFLICT',
            'This role changed. Reload before saving.',
            409,
          );
        }

        if (action === 'archive') {
          const usage = await tx.query(
            `
              SELECT
                1
              FROM
                memberships
              WHERE
                organisation_id = $1
                AND role = $2
                AND removed_at IS NULL
              UNION ALL
              SELECT
                1
              FROM
                workspace_invitations
              WHERE
                organisation_id = $1
                AND role = $2
                AND accepted_at IS NULL
                AND revoked_at IS NULL
                AND expires_at > now()
              LIMIT
                1
            `,
            [req.principal.organisation_id, id],
          );

          if (usage.rowCount) {
            throw new DomainError(
              'ROLE_IN_USE',
              'Reassign members and revoke pending invitations before archiving this role.',
              409,
            );
          }

          await tx.query(
            'UPDATE workspace_roles SET archived_at=now(), revision=revision+1 WHERE organisation_id=$1 AND id=$2',
            [req.principal.organisation_id, id],
          );

          await control.audit(tx, req.principal, 'workspace_role.archived', id);

          return { archived: true };
        }

        const updated = definition.parse({
          name: 'name' in input ? input.name : undefined,
          permissions: 'permissions' in input ? input.permissions : undefined,
        });

        const result = await tx.query(
          `
            UPDATE workspace_roles
            SET
              name = $3,
              permissions = $4,
              revision = revision + 1
            WHERE
              organisation_id = $1
              AND id = $2
            RETURNING
              id,
              name,
              permissions,
              revision
          `,
          [req.principal.organisation_id, id, updated.name, updated.permissions],
        );

        await control.audit(tx, req.principal, 'workspace_role.updated', id, {
          before: { name: role.name, permissions: role.permissions },
          ...updated,
        });

        return result.rows[0];
      });
    });
  }
}
