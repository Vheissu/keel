import type { Database, Transaction } from '../../../packages/database/src/index.js';
import {
  DomainError,
  type Permission,
  type Principal,
} from '../../../packages/domain/src/index.js';

export const roles = [
  'owner',
  'admin',
  'operator',
  'approver',
  'secret_manager',
  'reader',
] as const;

export type Role = (typeof roles)[number];

export const rolePermissions: Record<Role, Permission[]> = {
  owner: ['read', 'write', 'approve', 'manage_secrets'],
  admin: ['read', 'write', 'approve', 'manage_secrets'],
  operator: ['read', 'write'],
  approver: ['read', 'approve'],
  secret_manager: ['read', 'manage_secrets'],
  reader: ['read'],
};

export const unauthenticated = () =>
  new DomainError('UNAUTHENTICATED', 'Sign in again or use a valid API token.', 401);

export async function authenticateToken(
  db: Database | Transaction,
  tokenHash: string,
): Promise<Principal> {
  const row = (
    await db.query(
      `
        SELECT
          t.organisation_id,
          t.actor_id,
          a.name,
          t.permissions,
          t.id AS token_id,
          t.user_id,
          m.role,
          m.removed_at
        FROM
          api_tokens t
          JOIN actors a ON a.id = t.actor_id
          AND a.organisation_id = t.organisation_id
          LEFT JOIN memberships m ON m.organisation_id = t.organisation_id
          AND m.user_id = t.user_id
          AND m.actor_id = t.actor_id
        WHERE
          t.token_hash = $1
          AND t.revoked_at IS NULL
          AND (
            t.expires_at IS NULL
            OR t.expires_at > now()
          )
      `,
      [tokenHash],
    )
  ).rows[0];

  if (!row || (row.user_id && (!row.role || row.removed_at))) {
    throw unauthenticated();
  }

  if (row.user_id) {
    row.permissions = row.permissions.filter((permission: Permission) =>
      rolePermissions[row.role as Role].includes(permission),
    );
  }

  delete row.removed_at;

  return row;
}

// Serialize account administration with hosted writes, then recheck the credential and current role.
export async function lockPrincipal(tx: Transaction, p: Principal) {
  if (!p.user_id) {
    return;
  }

  await tx.query('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE', [p.organisation_id]);

  await tx.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [p.user_id]);

  const member = (
    await tx.query(
      `
        SELECT
          role
        FROM
          memberships
        WHERE
          organisation_id = $1
          AND user_id = $2
          AND actor_id = $3
          AND removed_at IS NULL
      `,
      [p.organisation_id, p.user_id, p.actor_id],
    )
  ).rows[0];

  if (!member) {
    throw unauthenticated();
  }

  const permissions = rolePermissions[member.role as Role];

  if (
    p.permissions.some((permission) => !permissions.includes(permission)) ||
    p.role !== member.role
  ) {
    throw new DomainError(
      'ACCESS_CHANGED',
      'Your workspace access changed. Refresh and try again.',
      403,
    );
  }

  const credential = p.session_id
    ? await tx.query(
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
          FOR SHARE
        `,
        [p.session_id, p.user_id],
      )
    : await tx.query(
        `
          SELECT
            1
          FROM
            api_tokens
          WHERE
            id = $1
            AND user_id = $2
            AND revoked_at IS NULL
            AND expires_at > now()
          FOR SHARE
        `,
        [p.token_id, p.user_id],
      );

  if (!credential.rowCount) {
    throw unauthenticated();
  }
}
