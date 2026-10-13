import { enforceWorkspaceAuth, workspaceAuthPolicy } from './workspace-auth-policy.js';
import { AccountSecurity, accountAudit } from './account-security.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transaction, type Transaction } from '../../../packages/database/src/index.js';
import { DomainError, type Principal } from '../../../packages/domain/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { sha256 } from './artifact-store.js';
import { rolePermissions, roles, type Role, unauthenticated } from './identity-policy.js';
import { hashPassword, verifyPassword, passwordInput } from './passwords.js';

export const emailInput = z.string().trim().toLowerCase().email().max(254);

export const roleInput = z.enum(roles);

export const opaqueInput = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);

export const permissionInput = z.enum(['read', 'write', 'approve', 'manage_secrets']);

export const tokenInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    permissions: z
      .array(permissionInput)
      .min(1)
      .max(4)
      .refine(
        (value) => value.includes('read') && new Set(value).size === value.length,
        'Choose distinct permissions including read.',
      ),
    expires_in_days: z.number().int().min(1).max(90),
  })
  .strict();

export const newOpaque = () => randomBytes(32).toString('base64url');

const csrfFor = (token: string) =>
  createHash('sha256').update(`keel-csrf:${token}`).digest('base64url');

export function identityOrigin(origin: string) {
  const url = new URL(origin);

  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error(
      'KEEL_PUBLIC_URL must be an HTTPS origin, or HTTP on loopback for development.',
    );
  }

  return url;
}

export class Identity {
  readonly origin: string;
  readonly cookieName: string;
  readonly secure: boolean;
  readonly security = new AccountSecurity(this);

  constructor(
    readonly control: ControlPlane,
    origin: string,
  ) {
    const url = identityOrigin(origin);

    this.origin = origin;
    this.secure = url.protocol === 'https:';
    this.cookieName = this.secure ? '__Host-keel_session' : 'keel_session';
  }

  csrf = csrfFor;

  cookie(token: string, clear = false) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 43200}${this.secure ? '; Secure' : ''}`;
  }

  cookieToken(req: FastifyRequest) {
    const matches = (req.headers.cookie || '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${this.cookieName}=`));

    const token = matches.length === 1 ? matches[0].slice(this.cookieName.length + 1) : '';

    return opaqueInput.safeParse(token).success ? token : '';
  }

  checkOrigin(req: FastifyRequest) {
    if (req.headers.origin !== this.origin) {
      throw new DomainError(
        'INVALID_ORIGIN',
        'This request must come from the Keel application.',
        403,
      );
    }
  }

  async session(req: FastifyRequest, optional = false) {
    const token = this.cookieToken(req);

    const row = token
      ? (
          await this.control.db.query(
            `
              SELECT
                s.id AS session_id,
                s.user_id,
                s.mfa_verified,
                s.sso_connection_id,
                s.authenticated_at,
                u.email,
                u.name
              FROM
                browser_sessions s
                JOIN users u ON u.id = s.user_id
              WHERE
                s.token_hash = $1
                AND s.revoked_at IS NULL
                AND s.expires_at > now()
                AND s.last_seen_at > now() - interval '1 hour'
                AND (
                  u.mfa_secret IS NULL
                  OR s.mfa_verified
                )
            `,
            [sha256(token)],
          )
        ).rows[0]
      : null;

    if (!row) {
      if (optional) {
        return null;
      }

      throw unauthenticated();
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      this.checkOrigin(req);

      if (req.headers['x-csrf-token'] !== csrfFor(token)) {
        throw new DomainError('INVALID_CSRF', 'Refresh the page and try again.', 403);
      }
    }

    await this.control.db.query(
      `
        UPDATE browser_sessions
        SET
          last_seen_at = now()
        WHERE
          id = $1
          AND last_seen_at < now() - interval '1 minute'
      `,
      [row.session_id],
    );

    return { ...row, csrf: csrfFor(token) } as {
      session_id: string;
      mfa_verified: boolean;
      sso_connection_id: string | null;
      authenticated_at: Date;
      user_id: string;
      email: string;
      name: string;
      csrf: string;
    };
  }

  async principal(req: FastifyRequest): Promise<Principal> {
    const session = (await this.session(req))!;
    const organisation = z.string().uuid().parse(req.headers['x-workspace-id']);

    const member = (
      await this.control.db.query(
        `
          SELECT
            actor_id,
            role
          FROM
            memberships
          WHERE
            organisation_id = $1
            AND user_id = $2
            AND removed_at IS NULL
        `,
        [organisation, session.user_id],
      )
    ).rows[0];

    if (!member) {
      throw new DomainError(
        'WORKSPACE_ACCESS_DENIED',
        'You no longer have access to this workspace.',
        403,
      );
    }

    const principal = {
      organisation_id: organisation,
      actor_id: member.actor_id,
      name: session.name,
      permissions: [...rolePermissions[member.role as Role]],
      user_id: session.user_id,
      session_id: session.session_id,
      role: member.role,
    };

    await enforceWorkspaceAuth(this.control.db, principal);

    return principal;
  }

  async sessionInfo(req: FastifyRequest) {
    const session = await this.session(req, true);

    if (!session) {
      return { enabled: true, user: null, memberships: [] };
    }

    const memberships = (
      await this.control.db.query(
        `
          SELECT
            m.organisation_id AS id,
            o.name,
            m.role,
            c.name AS sso_name,
            c.id AS sso_connection_id,
            EXISTS (
              SELECT
                1
              FROM
                sso_identities si
              WHERE
                si.connection_id = c.id
                AND si.user_id = m.user_id
            ) AS sso_linked
          FROM
            memberships m
            JOIN organisations o ON o.id = m.organisation_id
            LEFT JOIN sso_connections c ON c.organisation_id = o.id
          WHERE
            m.user_id = $1
            AND m.removed_at IS NULL
          ORDER BY
            o.name,
            o.id
        `,
        [session.user_id],
      )
    ).rows;

    return {
      enabled: true,
      user: { id: session.user_id, name: session.name, email: session.email },
      csrf: session.csrf,
      memberships,
      sso_workspace: session.sso_connection_id
        ? memberships.find((m) => m.sso_connection_id === session.sso_connection_id)?.id
        : null,
    };
  }

  async issueSession(
    tx: Transaction,
    userId: string,
    req?: FastifyRequest,
    mfaVerified = false,
    ssoConnection: string | null = null,
    authenticatedAt?: Date,
  ) {
    const token = newOpaque();

    await tx.query(
      `
        INSERT INTO
          browser_sessions (
            id,
            user_id,
            token_hash,
            expires_at,
            user_agent,
            ip_address,
            mfa_verified,
            sso_connection_id,
            authenticated_at
          )
        VALUES
          (
            $1,
            $2,
            $3,
            COALESCE($8::timestamptz, now()) + interval '12 hours',
            $4,
            $5,
            $6,
            $7,
            COALESCE($8::timestamptz, now())
          )
      `,
      [
        randomUUID(),
        userId,
        sha256(token),
        (req?.headers['user-agent'] || '').slice(0, 512),
        (req?.ip || '').slice(0, 255),
        mfaVerified,
        ssoConnection,
        authenticatedAt ?? null,
      ],
    );

    await tx.query(
      `
        UPDATE browser_sessions
        SET
          revoked_at = now()
        WHERE
          id IN (
            SELECT
              id
            FROM
              browser_sessions
            WHERE
              user_id = $1
              AND revoked_at IS NULL
            ORDER BY
              created_at DESC,
              id DESC
            OFFSET
              25
          )
      `,
      [userId],
    );

    return token;
  }

  async attemptBudget(subject: string) {
    // A database-backed account budget applies across API instances, including unknown emails.
    await this.control.db.query(
      "DELETE FROM login_attempts WHERE window_start < now()-interval '10 minutes'",
    );

    const budget = (
      await this.control.db.query(
        `
          INSERT INTO
            login_attempts (subject_hash)
          VALUES
            ($1)
          ON CONFLICT (subject_hash) DO UPDATE
          SET
            attempts = CASE
              WHEN login_attempts.window_start < now() - interval '1 minute' THEN 1
              ELSE login_attempts.attempts + 1
            END,
            window_start = CASE
              WHEN login_attempts.window_start < now() - interval '1 minute' THEN now()
              ELSE login_attempts.window_start
            END
          RETURNING
            attempts
        `,
        [sha256(subject)],
      )
    ).rows[0];

    if (budget.attempts > 8) {
      throw new DomainError(
        'LOGIN_RATE_LIMIT',
        'Too many sign-in attempts. Try again in a minute.',
        429,
      );
    }
  }

  async login(email: string, password: string, req?: FastifyRequest) {
    await this.attemptBudget(email);

    const user = (await this.control.db.query('SELECT * FROM users WHERE email=$1', [email]))
      .rows[0];

    if (!(await verifyPassword(password, user?.password_hash))) {
      throw new DomainError('UNAUTHENTICATED', 'Email or password is incorrect.', 401);
    }

    return transaction(this.control.db, async (tx) => {
      const locked = (
        await tx.query('SELECT password_hash,mfa_secret FROM users WHERE id=$1 FOR NO KEY UPDATE', [
          user.id,
        ])
      ).rows[0];

      if (locked.password_hash !== user.password_hash) {
        throw unauthenticated();
      }

      if (locked.mfa_secret) {
        const challenge = newOpaque();

        await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1 OR expires_at<=now()', [
          user.id,
        ]);

        await tx.query(
          `
            INSERT INTO
              mfa_challenges (token_hash, user_id, expires_at)
            VALUES
              ($1, $2, now() + interval '5 minutes')
          `,
          [sha256(challenge), user.id],
        );

        return { challenge };
      }

      await accountAudit(tx, user.id, 'account.signed_in');

      return { token: await this.issueSession(tx, user.id, req) };
    });
  }

  admin(p: Principal, owner = false) {
    if (
      !p.session_id ||
      !(owner ? p.role === 'owner' : ['owner', 'admin'].includes(p.role || ''))
    ) {
      throw new DomainError(
        'FORBIDDEN',
        owner
          ? 'Only a workspace owner can do this.'
          : 'Sign in as a workspace owner or administrator.',
        403,
      );
    }
  }

  invitation(tx: Transaction, organisationId: string, email: string, role: Role) {
    return createInvitation(tx, this.origin, organisationId, email, role);
  }

  async inspectInvitation(token: string) {
    const row = (
      await this.control.db.query(
        `
          SELECT
            i.email,
            i.role,
            o.name AS workspace,
            EXISTS (
              SELECT
                1
              FROM
                users u
              WHERE
                u.email = i.email
            ) AS existing_account
          FROM
            workspace_invitations i
            JOIN organisations o ON o.id = i.organisation_id
          WHERE
            i.token_hash = $1
            AND i.accepted_at IS NULL
            AND i.revoked_at IS NULL
            AND i.expires_at > now()
        `,
        [sha256(token)],
      )
    ).rows[0];

    if (!row) {
      throw new DomainError(
        'INVITATION_INVALID',
        'This invitation has expired or is no longer available.',
        400,
      );
    }

    return row;
  }

  async accept(req: FastifyRequest, input: { token: string; name?: string; password?: string }) {
    const details = await this.inspectInvitation(input.token);
    const session = await this.session(req, true);

    if (details.existing_account && session?.email !== details.email) {
      throw new DomainError(
        'SIGN_IN_REQUIRED',
        'Sign in with the invited email address before accepting.',
        403,
      );
    }

    const passwordHash = details.existing_account
      ? null
      : await hashPassword(passwordInput.parse(input.password));

    const name = details.existing_account
      ? session!.name
      : z.string().trim().min(1).max(100).parse(input.name);

    return transaction(this.control.db, async (tx) => {
      // Consistent workspace-first locking prevents acceptance racing removal or invitation revocation.
      const found = (
        await tx.query('SELECT organisation_id FROM workspace_invitations WHERE token_hash=$1', [
          sha256(input.token),
        ])
      ).rows[0];

      if (!found) {
        throw new DomainError('INVITATION_INVALID', 'Invitation is unavailable.');
      }

      await tx.query('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE', [
        found.organisation_id,
      ]);

      const invite = (
        await tx.query(
          `
            SELECT
              *
            FROM
              workspace_invitations
            WHERE
              token_hash = $1
              AND accepted_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > now()
            FOR UPDATE
          `,
          [sha256(input.token)],
        )
      ).rows[0];

      if (!invite) {
        throw new DomainError('INVITATION_INVALID', 'Invitation is unavailable.');
      }

      let userId = session?.user_id;

      if (!details.existing_account) {
        userId = randomUUID();

        await tx.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
          userId,
          invite.email,
          name,
          passwordHash,
        ]);
      } else {
        // Password changes and logout revoke sessions; check again in this transaction.
        await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [userId]);

        const valid = await tx.query(
          `
            SELECT
              1
            FROM
              browser_sessions
            WHERE
              id = $1
              AND user_id = $2
              AND revoked_at IS NULL
              AND expires_at > now()
              AND last_seen_at > now() - interval '1 hour'
              AND (
                mfa_verified
                OR NOT EXISTS (
                  SELECT
                    1
                  FROM
                    users
                  WHERE
                    id = $2
                    AND mfa_secret IS NOT NULL
                )
              )
            FOR SHARE
          `,
          [session!.session_id, userId],
        );

        if (!valid.rowCount) {
          throw unauthenticated();
        }
      }

      const previous = (
        await tx.query('SELECT * FROM memberships WHERE organisation_id=$1 AND user_id=$2', [
          invite.organisation_id,
          userId,
        ])
      ).rows[0];

      if (previous && !previous.removed_at) {
        throw new DomainError(
          'ALREADY_MEMBER',
          'This account already belongs to this workspace.',
          409,
        );
      }

      const actorId = previous?.actor_id || randomUUID();

      if (!previous) {
        await tx.query('INSERT INTO actors(id,organisation_id,name) VALUES($1,$2,$3)', [
          actorId,
          invite.organisation_id,
          name,
        ]);
      }

      await tx.query(
        `
          INSERT INTO
            memberships (organisation_id, user_id, actor_id, role)
          VALUES
            ($1, $2, $3, $4)
          ON CONFLICT (organisation_id, user_id) DO UPDATE
          SET ROLE = excluded.role,
          removed_at = NULL
        `,
        [invite.organisation_id, userId, actorId, invite.role],
      );

      await tx.query('UPDATE workspace_invitations SET accepted_at=now() WHERE id=$1', [invite.id]);

      await this.control.audit(
        tx,
        { organisation_id: invite.organisation_id, actor_id: actorId, name, permissions: [] },
        'membership.joined',
        actorId,
        { role: invite.role },
      );

      return this.issueSession(
        tx,
        userId!,
        req,
        session?.mfa_verified ?? false,
        session?.sso_connection_id ?? null,
        session?.authenticated_at,
      );
    });
  }

  async changeMember(tx: Transaction, p: Principal, userId: string, role: Role | null) {
    this.admin(p);

    const member = (
      await tx.query(
        `
          SELECT
            *
          FROM
            memberships
          WHERE
            organisation_id = $1
            AND user_id = $2
            AND removed_at IS NULL
        `,
        [p.organisation_id, userId],
      )
    ).rows[0];

    if (!member) {
      throw new DomainError('NOT_FOUND', 'Member not found.', 404);
    }

    if (
      member.role === 'owner' ||
      role === 'owner' ||
      member.role === 'admin' ||
      role === 'admin'
    ) {
      this.admin(p, true);
    }

    if (member.role === 'owner' && role !== 'owner') {
      const count = (
        await tx.query(
          `
            SELECT
              count(*)
            FROM
              memberships
            WHERE
              organisation_id = $1
              AND role = 'owner'
              AND removed_at IS NULL
          `,
          [p.organisation_id],
        )
      ).rows[0].count;

      if (Number(count) <= 1) {
        throw new DomainError('LAST_OWNER', 'Keep at least one workspace owner.', 409);
      }
    }

    await tx.query(
      `
        UPDATE memberships
        SET ROLE = COALESCE($3, role),
        removed_at = CASE
          WHEN $3::text IS NULL THEN now()
          ELSE NULL
        END
        WHERE
          organisation_id = $1
          AND user_id = $2
      `,
      [p.organisation_id, userId, role],
    );

    if (!role) {
      await tx.query(
        `
          UPDATE api_tokens
          SET
            revoked_at = now()
          WHERE
            organisation_id = $1
            AND user_id = $2
            AND revoked_at IS NULL
        `,
        [p.organisation_id, userId],
      );

      await tx.query(
        `
          UPDATE workspace_invitations
          SET
            revoked_at = now()
          WHERE
            organisation_id = $1
            AND email = (
              SELECT
                email
              FROM
                users
              WHERE
                id = $2
            )
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        `,
        [p.organisation_id, userId],
      );
    }

    await this.control.audit(
      tx,
      p,
      role ? 'membership.role_changed' : 'membership.removed',
      member.actor_id,
      { role },
    );

    return { updated: true };
  }

  async issueToken(tx: Transaction, p: Principal, input: z.infer<typeof tokenInput>) {
    if (!p.session_id || !p.user_id) {
      throw new DomainError('FORBIDDEN', 'Sign in to manage your API tokens.', 403);
    }

    const policy = await workspaceAuthPolicy(tx, p.organisation_id);

    if (!policy.allow_api_tokens) {
      throw new DomainError(
        'AUTH_POLICY_REQUIRED',
        'API tokens are disabled for this workspace.',
        403,
      );
    }

    if (input.permissions.some((permission) => !p.permissions.includes(permission))) {
      throw new DomainError('FORBIDDEN', 'Tokens cannot exceed your workspace permissions.', 403);
    }

    const token = `keel_${newOpaque()}`;

    const row = (
      await tx.query(
        `
          INSERT INTO
            api_tokens (
              id,
              organisation_id,
              actor_id,
              user_id,
              token_hash,
              permissions,
              name,
              expires_at
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              now() + $8 * interval '1 day'
            )
          RETURNING
            id,
            name,
            permissions,
            expires_at,
            created_at
        `,
        [
          randomUUID(),
          p.organisation_id,
          p.actor_id,
          p.user_id,
          sha256(token),
          input.permissions,
          input.name,
          input.expires_in_days,
        ],
      )
    ).rows[0];

    await this.control.audit(tx, p, 'api_token.created', row.id, {
      name: input.name,
      permissions: input.permissions,
      expires_at: row.expires_at,
    });

    return { ...row, token };
  }
}

export async function createInvitation(
  tx: Transaction,
  origin: string,
  organisationId: string,
  email: string,
  role: Role,
) {
  await tx.query(
    `
      UPDATE workspace_invitations
      SET
        revoked_at = now()
      WHERE
        organisation_id = $1
        AND email = $2
        AND accepted_at IS NULL
        AND revoked_at IS NULL
    `,
    [organisationId, email],
  );

  const token = newOpaque();

  const row = (
    await tx.query(
      `
        INSERT INTO
          workspace_invitations (
            id,
            organisation_id,
            email,
            role,
            token_hash,
            expires_at
          )
        VALUES
          ($1, $2, $3, $4, $5, now() + interval '48 hours')
        RETURNING
          id,
          email,
          role,
          expires_at
      `,
      [randomUUID(), organisationId, email, role, sha256(token)],
    )
  ).rows[0];

  return { ...row, link: `${origin}/#accept-invite?token=${token}` };
}
