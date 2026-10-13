import { accountAudit, revokeAccountCredentials } from '../../api/src/account-security.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type Database } from '../../../packages/database/src/index.js';
import { createInvitation, identityOrigin, emailInput, newOpaque } from '../../api/src/identity.js';
import { auditEvent } from '../../api/src/audit.js';
import { sha256 } from '../../api/src/artifact-store.js';

// These commands require database/operator access. Workspace administrators cannot reset global accounts.
export async function identityAdmin(db: Database, args: string[], origin: string) {
  const [command, first, second] = args;

  identityOrigin(origin);

  if (command === 'reset-mfa' && args.length === 2) {
    const email = emailInput.parse(first);

    await transaction(db, async (tx) => {
      const user = (
        await tx.query('SELECT id FROM users WHERE email=$1 FOR NO KEY UPDATE', [email])
      ).rows[0];

      if (!user) {
        throw new Error('Account not found.');
      }

      await tx.query(
        'UPDATE users SET mfa_secret=NULL,mfa_enabled_at=NULL,mfa_last_step=NULL WHERE id=$1',
        [user.id],
      );

      await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [user.id]);

      await tx.query(
        'UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
        [user.id],
      );

      await revokeAccountCredentials(tx, user.id);
      await accountAudit(tx, user.id, 'account.mfa_reset_by_operator');
    });

    return { reset: true };
  }

  if (command === 'reset-password' && args.length === 2) {
    const email = emailInput.parse(first);
    const token = newOpaque();

    await transaction(db, async (tx) => {
      const user = (
        await tx.query('SELECT id FROM users WHERE email=$1 FOR NO KEY UPDATE', [email])
      ).rows[0];

      if (!user) {
        throw new Error('Account not found.');
      }

      await tx.query(
        'UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
        [user.id],
      );

      await tx.query(
        `
          INSERT INTO
            password_resets (id, user_id, token_hash, expires_at)
          VALUES
            ($1, $2, $3, now() + interval '15 minutes')
        `,
        [randomUUID(), user.id, sha256(token)],
      );
    });

    return { link: `${origin}/#reset-password?token=${token}`, expires_in_minutes: 15 };
  }

  if (['invite-owner', 'create-workspace'].includes(command) && args.length === 3) {
    const email = emailInput.parse(second);

    return transaction(db, async (tx) => {
      const id = command === 'create-workspace' ? randomUUID() : z.string().uuid().parse(first);

      if (command === 'create-workspace') {
        const name = z.string().trim().min(1).max(100).parse(first);

        await tx.query('INSERT INTO organisations(id,name) VALUES($1,$2)', [id, name]);

        for (const slug of ['staging', 'production']) {
          await tx.query(
            `
              INSERT INTO
                environments (
                  id,
                  organisation_id,
                  name,
                  slug,
                  requires_approval
                )
              VALUES
                ($1, $2, $3, $4, $5)
            `,
            [
              randomUUID(),
              id,
              slug === 'staging' ? 'Staging' : 'Production',
              slug,
              slug === 'production',
            ],
          );
        }
      }

      const workspace = await tx.query(
        'SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE',
        [id],
      );

      if (!workspace.rowCount) {
        throw new Error('Workspace not found.');
      }

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
        [id, email],
      );

      if (member.rowCount) {
        throw new Error(
          'This account is already a member. An owner can change its role in Workspace access.',
        );
      }

      const invite = await createInvitation(tx, origin, id, email, 'owner');
      const actorId = randomUUID();

      await tx.query(
        "INSERT INTO actors(id,organisation_id,name) VALUES($1,$2,'Server operator')",
        [actorId, id],
      );

      await auditEvent(
        tx,
        { organisation_id: id, actor_id: actorId, name: 'Server operator', permissions: [] },
        'invitation.provisioned',
        invite.id,
        { email, role: 'owner' },
      );

      return { workspace_id: id, ...invite };
    });
  }

  throw new Error(
    'Use invite-owner <workspace-id> <email>, create-workspace <name> <email>, reset-password <email>, or reset-mfa <email>.',
  );
}
