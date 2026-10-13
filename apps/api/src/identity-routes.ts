import { Sso } from './sso.js';
import {
  authPolicyInput,
  workspaceAuthPolicy,
  enforceWorkspaceAuth,
} from './workspace-auth-policy.js';
import { clearChallenges } from './account-security.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transaction, type Transaction } from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { Identity, emailInput, roleInput, opaqueInput, tokenInput } from './identity.js';
import { passwordInput, hashPassword, verifyPassword } from './passwords.js';
import { sha256 } from './artifact-store.js';

const uuid = z.string().uuid();
const empty = z.object({}).strict();

export async function registerAuthRoutes(app: FastifyInstance, identity?: Identity) {
  app.get('/api/auth/session', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    return identity ? identity.sessionInfo(req) : { enabled: false, user: null, memberships: [] };
  });

  if (!identity) {
    return;
  }

  const control = identity.control;

  await identity.security.register(app);
  await new Sso(identity).register(app);

  await app.register(
    async (auth) => {
      auth.addHook('onRequest', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        identity.checkOrigin(req);
      });

      const limited = { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };

      auth.post('/login', limited, async (req, reply) => {
        const input = z
          .object({ email: emailInput, password: z.string().min(1).max(128) })
          .strict()
          .parse(req.body);

        const result = await identity.login(input.email, input.password, req);

        if ('challenge' in result) {
          return { mfa_required: true, challenge: result.challenge };
        }

        reply.header('Set-Cookie', identity.cookie(result.token));

        return { signed_in: true };
      });

      auth.post('/logout', async (req, reply) => {
        empty.parse(req.body);
        const session = await identity.session(req);

        await transaction(control.db, async (tx) => {
          await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [session!.user_id]);

          await tx.query('UPDATE browser_sessions SET revoked_at=now() WHERE id=$1', [
            session!.session_id,
          ]);
        });

        reply.header('Set-Cookie', identity.cookie('', true));

        return { signed_out: true };
      });

      auth.post('/invitation', limited, async (req) => {
        const input = z.object({ token: opaqueInput }).strict().parse(req.body);

        return identity.inspectInvitation(input.token);
      });

      auth.post('/accept', limited, async (req, reply) => {
        const input = z
          .object({
            token: opaqueInput,
            name: z.string().trim().min(1).max(100).optional(),
            password: passwordInput.optional(),
          })
          .strict()
          .parse(req.body);

        const token = await identity.accept(req, input);

        reply.header('Set-Cookie', identity.cookie(token));

        return { accepted: true };
      });

      auth.post('/password', limited, async (req, reply) => {
        const input = z
          .object({ current_password: z.string().min(1).max(128), password: passwordInput })
          .strict()
          .parse(req.body);

        const session = (await identity.session(req))!;

        const user = (
          await control.db.query('SELECT password_hash FROM users WHERE id=$1', [session.user_id])
        ).rows[0];

        if (!(await verifyPassword(input.current_password, user.password_hash))) {
          throw new DomainError('INVALID_PASSWORD', 'Current password is incorrect.', 403);
        }

        const next = await hashPassword(input.password);

        await transaction(control.db, async (tx) => {
          const locked = (
            await tx.query('SELECT password_hash FROM users WHERE id=$1 FOR NO KEY UPDATE', [
              session.user_id,
            ])
          ).rows[0];

          const validSession = await tx.query(
            `
              SELECT
                1
              FROM
                browser_sessions
              WHERE
                id = $1
                AND revoked_at IS NULL
                AND expires_at > now()
                AND last_seen_at > now() - interval '1 hour'
            `,
            [session.session_id],
          );

          if (locked.password_hash !== user.password_hash || !validSession.rowCount) {
            throw new DomainError(
              'ACCESS_CHANGED',
              'Sign in again before changing your password.',
              403,
            );
          }

          await resetPassword(tx, session.user_id, next);
        });

        reply.header('Set-Cookie', identity.cookie('', true));

        return { changed: true };
      });

      auth.post('/reset-password', limited, async (req, reply) => {
        const input = z
          .object({ token: opaqueInput, password: passwordInput })
          .strict()
          .parse(req.body);

        const reset = (
          await control.db.query(
            `
              SELECT
                user_id
              FROM
                password_resets
              WHERE
                token_hash = $1
                AND used_at IS NULL
                AND expires_at > now()
            `,
            [sha256(input.token)],
          )
        ).rows[0];

        if (!reset) {
          throw new DomainError(
            'RESET_INVALID',
            'This recovery link has expired or was already used.',
          );
        }

        const next = await hashPassword(input.password);

        await transaction(control.db, async (tx) => {
          await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [reset.user_id]);

          const updated = await tx.query(
            `
              UPDATE password_resets
              SET
                used_at = now()
              WHERE
                token_hash = $1
                AND used_at IS NULL
                AND expires_at > now()
              RETURNING
                user_id
            `,
            [sha256(input.token)],
          );

          if (!updated.rowCount) {
            throw new DomainError(
              'RESET_INVALID',
              'This recovery link has expired or was already used.',
            );
          }

          await resetPassword(tx, reset.user_id, next);
        });

        reply.header('Set-Cookie', identity.cookie('', true));

        return { changed: true };
      });
    },
    { prefix: '/api/auth' },
  );
}

async function resetPassword(tx: Transaction, userId: string, hash: string) {
  await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, hash]);
  await clearChallenges(tx, userId);

  await tx.query(
    'UPDATE browser_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
    [userId],
  );

  await tx.query('UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [
    userId,
  ]);

  await tx.query('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [
    userId,
  ]);

  await tx.query(
    `
      INSERT INTO
        audit_events (
          id,
          organisation_id,
          actor_id,
          action,
          resource_id,
          details
        )
      SELECT
        gen_random_uuid(),
        organisation_id,
        actor_id,
        'account.password_changed',
        actor_id,
        '{}'::jsonb
      FROM
        memberships
      WHERE
        user_id = $1
        AND removed_at IS NULL
    `,
    [userId],
  );
}

export async function registerIdentityRoutes(api: FastifyInstance, identity?: Identity) {
  if (!identity) {
    return;
  }

  const control = identity.control;

  const mutate = <T>(req: FastifyRequest, work: (tx: Transaction) => Promise<T>) =>
    control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] || ''),
      sha256(`${req.method}:${req.url}:${JSON.stringify(req.body ?? {})}`),
      work,
    );

  const sessionOnly = (req: FastifyRequest) => {
    if (!req.principal.session_id) {
      throw new DomainError('FORBIDDEN', 'Sign in to manage workspace access.', 403);
    }
  };

  const pageInput = z
    .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
    .strict();

  api.get('/identity/auth-policy', async (req) => {
    sessionOnly(req);

    return workspaceAuthPolicy(control.db, req.principal.organisation_id);
  });

  api.post('/identity/auth-policy', async (req) => {
    identity.admin(req.principal, true);
    const policy = authPolicyInput.parse(req.body);

    return mutate(req, async (tx) => {
      // An owner must prove the new requirements before enforcing them for everyone.
      await enforceWorkspaceAuth(tx, req.principal, policy);

      await tx.query(
        `
          INSERT INTO
            workspace_auth_policies (
              organisation_id,
              require_sso,
              require_mfa,
              allow_api_tokens,
              session_minutes
            )
          VALUES
            ($1, $2, $3, $4, $5)
          ON CONFLICT (organisation_id) DO UPDATE
          SET
            require_sso = $2,
            require_mfa = $3,
            allow_api_tokens = $4,
            session_minutes = $5
        `,
        [
          req.principal.organisation_id,
          policy.require_sso,
          policy.require_mfa,
          policy.allow_api_tokens,
          policy.session_minutes,
        ],
      );

      // Existing automation credentials must be reissued under the new policy.
      await tx.query(
        `
          UPDATE api_tokens
          SET
            revoked_at = now()
          WHERE
            organisation_id = $1
            AND user_id IS NOT NULL
            AND revoked_at IS NULL
        `,
        [req.principal.organisation_id],
      );

      await control.audit(
        tx,
        req.principal,
        'workspace.auth_policy_changed',
        req.principal.organisation_id,
        policy,
      );

      return policy;
    });
  });

  api.get('/identity/members', async (req) => {
    identity.admin(req.principal);
    const { offset } = pageInput.parse(req.query);

    const rows = (
      await control.db.query(
        `
          SELECT
            m.user_id AS id,
            u.email,
            u.name,
            m.role,
            m.created_at
          FROM
            memberships m
            JOIN users u ON u.id = m.user_id
          WHERE
            m.organisation_id = $1
            AND m.removed_at IS NULL
          ORDER BY
            m.created_at,
            m.user_id
          LIMIT
            51
          OFFSET
            $2
        `,
        [req.principal.organisation_id, offset],
      )
    ).rows;

    return { items: rows.slice(0, 50), more: rows.length > 50 };
  });

  api.get('/identity/invitations', async (req) => {
    identity.admin(req.principal);
    const { offset } = pageInput.parse(req.query);

    const rows = (
      await control.db.query(
        `
          SELECT
            id,
            email,
            role,
            expires_at,
            accepted_at,
            revoked_at
          FROM
            workspace_invitations
          WHERE
            organisation_id = $1
          ORDER BY
            created_at DESC,
            id DESC
          LIMIT
            51
          OFFSET
            $2
        `,
        [req.principal.organisation_id, offset],
      )
    ).rows;

    return { items: rows.slice(0, 50), more: rows.length > 50 };
  });

  api.post('/identity/invitations', async (req) => {
    identity.admin(req.principal);
    const input = z.object({ email: emailInput, role: roleInput }).strict().parse(req.body);

    if (['owner', 'admin'].includes(input.role)) {
      identity.admin(req.principal, true);
    }

    let link: string | undefined;

    const result = await mutate(req, async (tx) => {
      const member = await tx.query(
        `
          SELECT
            1
          FROM
            memberships m
            JOIN users u ON u.id = m.user_id
          WHERE
            m.organisation_id = $1
            AND u.email = $2
            AND m.removed_at IS NULL
        `,
        [req.principal.organisation_id, input.email],
      );

      if (member.rowCount) {
        throw new DomainError(
          'ALREADY_MEMBER',
          'This account already belongs to this workspace.',
          409,
        );
      }

      const protectedInvitation = await tx.query(
        `
          SELECT
            1
          FROM
            workspace_invitations
          WHERE
            organisation_id = $1
            AND email = $2
            AND role IN ('owner', 'admin')
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now()
        `,
        [req.principal.organisation_id, input.email],
      );

      if (protectedInvitation.rowCount) {
        identity.admin(req.principal, true);
      }

      const issued = await identity.invitation(
        tx,
        req.principal.organisation_id,
        input.email,
        input.role,
      );

      link = issued.link;
      const { link: _link, ...metadata } = issued;

      await control.audit(tx, req.principal, 'invitation.created', issued.id, {
        email: input.email,
        role: input.role,
      });

      return metadata;
    });

    // One-time secrets must never be persisted in idempotency responses.
    return { ...result, link };
  });

  api.post<{ Params: { id: string } }>('/identity/invitations/:id/revoke', async (req) => {
    identity.admin(req.principal);
    empty.parse(req.body);
    const id = uuid.parse(req.params.id);

    return mutate(req, async (tx) => {
      const invite = (
        await tx.query(
          'SELECT role FROM workspace_invitations WHERE id=$1 AND organisation_id=$2',
          [id, req.principal.organisation_id],
        )
      ).rows[0];

      if (!invite) {
        throw new DomainError('NOT_FOUND', 'Invitation not found.', 404);
      }

      if (['owner', 'admin'].includes(invite.role)) {
        identity.admin(req.principal, true);
      }

      await tx.query(
        `
          UPDATE workspace_invitations
          SET
            revoked_at = COALESCE(revoked_at, now())
          WHERE
            id = $1
            AND accepted_at IS NULL
        `,
        [id],
      );

      await control.audit(tx, req.principal, 'invitation.revoked', id);

      return { revoked: true };
    });
  });

  api.post<{ Params: { id: string } }>('/identity/members/:id', async (req) => {
    identity.admin(req.principal);
    const input = z.object({ role: roleInput.nullable() }).strict().parse(req.body);
    const id = uuid.parse(req.params.id);

    return mutate(req, (tx) => identity.changeMember(tx, req.principal, id, input.role));
  });

  api.get('/identity/tokens', async (req) => {
    sessionOnly(req);
    const { offset } = pageInput.parse(req.query);

    const rows = (
      await control.db.query(
        `
          SELECT
            t.id,
            t.user_id,
            t.name,
            t.permissions,
            t.expires_at,
            t.revoked_at,
            t.created_at,
            u.email
          FROM
            api_tokens t
            JOIN users u ON u.id = t.user_id
          WHERE
            t.organisation_id = $1
            AND (
              $2::boolean
              OR t.user_id = $3
            )
          ORDER BY
            t.created_at DESC,
            t.id DESC
          LIMIT
            51
          OFFSET
            $4
        `,
        [
          req.principal.organisation_id,
          ['owner', 'admin'].includes(req.principal.role || ''),
          req.principal.user_id,
          offset,
        ],
      )
    ).rows;

    return { items: rows.slice(0, 50), more: rows.length > 50 };
  });

  for (const route of ['/identity/tokens', '/identity/tokens/:id/rotate']) {
    api.post<{ Params: { id?: string } }>(route, async (req) => {
      sessionOnly(req);
      const input = tokenInput.parse(req.body);
      const id = req.params.id ? uuid.parse(req.params.id) : null;
      let token: string | undefined;

      const result = await mutate(req, async (tx) => {
        if (id) {
          const old = await tx.query(
            `
              UPDATE api_tokens
              SET
                revoked_at = now()
              WHERE
                id = $1
                AND organisation_id = $2
                AND user_id = $3
                AND revoked_at IS NULL
                AND expires_at > now()
              RETURNING
                id
            `,
            [id, req.principal.organisation_id, req.principal.user_id],
          );

          if (!old.rowCount) {
            throw new DomainError('NOT_FOUND', 'Active token not found.', 404);
          }

          await control.audit(tx, req.principal, 'api_token.rotated', id);
        }

        const issued = await identity.issueToken(tx, req.principal, input);

        token = issued.token;
        const { token: _token, ...metadata } = issued;

        return metadata;
      });

      return { ...result, token };
    });
  }

  api.post<{ Params: { id: string } }>('/identity/tokens/:id/revoke', async (req) => {
    sessionOnly(req);
    empty.parse(req.body);
    const id = uuid.parse(req.params.id);

    return mutate(req, async (tx) => {
      const token = (
        await tx.query(
          `
            SELECT
              user_id
            FROM
              api_tokens
            WHERE
              id = $1
              AND organisation_id = $2
              AND user_id IS NOT NULL
          `,
          [id, req.principal.organisation_id],
        )
      ).rows[0];

      if (!token) {
        throw new DomainError('NOT_FOUND', 'Token not found.', 404);
      }

      if (token.user_id !== req.principal.user_id) {
        identity.admin(req.principal);
      }

      await tx.query('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [
        id,
      ]);

      await control.audit(tx, req.principal, 'api_token.revoked', id);

      return { revoked: true };
    });
  });
}
