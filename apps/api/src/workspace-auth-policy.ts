import { z } from 'zod';
import type { Database, Transaction } from '../../../packages/database/src/index.js';
import { DomainError, type Principal } from '../../../packages/domain/src/index.js';

export const authPolicyInput = z
  .object({
    require_sso: z.boolean(),
    require_mfa: z.boolean(),
    allow_api_tokens: z.boolean(),
    session_minutes: z.number().int().min(15).max(720),
  })
  .strict();

export const defaultAuthPolicy = {
  require_sso: false,
  require_mfa: false,
  allow_api_tokens: true,
  session_minutes: 720,
};

export async function workspaceAuthPolicy(
  db: Database | Transaction,
  organisation: string,
): Promise<z.infer<typeof authPolicyInput>> {
  const result = await db.query('SELECT * FROM workspace_auth_policies WHERE organisation_id=$1', [
    organisation,
  ]);

  return result.rows[0] || defaultAuthPolicy;
}

export async function enforceWorkspaceAuth(
  db: Database | Transaction,
  p: Principal,
  policy?: z.infer<typeof authPolicyInput>,
) {
  if (!p.user_id) {
    return;
  }

  const requirements = policy ?? (await workspaceAuthPolicy(db, p.organisation_id));

  const user = (
    await db.query('SELECT mfa_secret IS NOT NULL AS mfa_enabled FROM users WHERE id=$1', [
      p.user_id,
    ])
  ).rows[0];

  let reason = '';

  if (p.session_id) {
    const session = (
      await db.query(
        `
          SELECT
            s.mfa_verified,
            s.sso_connection_id,
            c.organisation_id AS sso_workspace,
            s.authenticated_at > now() - ($2 * interval '1 minute') AS fresh
          FROM
            browser_sessions s
            LEFT JOIN sso_connections c ON c.id = s.sso_connection_id
          WHERE
            s.id = $1
            AND s.user_id = $3
        `,
        [p.session_id, requirements.session_minutes, p.user_id],
      )
    ).rows[0];

    if (!session || !session.fresh) {
      reason = 'Sign in again to meet this workspace’s session time limit.';
    } else if (session.sso_connection_id && session.sso_workspace !== p.organisation_id) {
      reason = 'This SSO session belongs to another workspace. Sign in for this workspace.';
    } else if (requirements.require_sso && session.sso_workspace !== p.organisation_id) {
      reason = 'This workspace requires SSO. Connect your account and sign in with SSO.';
    } else if (requirements.require_mfa && (!user?.mfa_enabled || !session.mfa_verified)) {
      reason =
        'This workspace requires an authenticator. Set it up in Account security, then sign in again.';
    }
  } else if (!requirements.allow_api_tokens) {
    reason = 'API tokens are disabled for this workspace.';
  } else if (requirements.require_mfa && !user?.mfa_enabled) {
    reason = 'This workspace requires an authenticator before API tokens can be used.';
  }

  if (reason) {
    throw new DomainError('AUTH_POLICY_REQUIRED', reason, 403);
  }
}
