import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transaction, type Transaction } from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import type { Identity } from './identity.js';
import { CredentialVault } from './credential-vault.js';
import { sha256 } from './artifact-store.js';
import { verifyPassword } from './passwords.js';
import { base32, newTotpSecret, verifyTotp } from './totp.js';
import { unauthenticated } from './identity-policy.js';

const codeInput = z.string().trim().max(64);
const passwordProof = z.object({ current_password: z.string().min(1).max(128) }).strict();
const factorProof = passwordProof.extend({ code: codeInput });

const invalidCode = () =>
  new DomainError('INVALID_MFA', 'Code is invalid or already used. Try a new code.', 403);

export function mfaVault() {
  const key = process.env.KEEL_CREDENTIAL_KEY;

  if (!key) {
    throw new DomainError(
      'MFA_UNAVAILABLE',
      'Authenticator setup requires the server credential key.',
      503,
    );
  }

  return new CredentialVault(key, 'mfa');
}

export async function accountAudit(tx: Transaction, userId: string, action: string, details = {}) {
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
        $2,
        actor_id,
        $3::jsonb
      FROM
        memberships
      WHERE
        user_id = $1
        AND removed_at IS NULL
    `,
    [userId, action, JSON.stringify(details)],
  );
}

export async function clearChallenges(tx: Transaction, userId: string) {
  await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1', [userId]);
  await tx.query('DELETE FROM mfa_enrollments WHERE user_id=$1', [userId]);
}

export async function revokeAccountCredentials(tx: Transaction, userId: string) {
  await tx.query(
    'UPDATE browser_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
    [userId],
  );

  await tx.query('UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [
    userId,
  ]);

  await clearChallenges(tx, userId);
}

export class AccountSecurity {
  constructor(readonly identity: Identity) {}

  async budget(userId: string) {
    await this.identity.attemptBudget(`mfa:${userId}`);
  }

  // Call only while holding the user row lock. A code is consumed in the same transaction as its action.
  async consume(
    tx: Transaction,
    user: { id: string; mfa_secret: unknown; mfa_last_step: string | null },
    code: string,
  ) {
    if (!user.mfa_secret) {
      return false;
    }

    if (/^\d{6}$/.test(code)) {
      const secret = mfaVault().decrypt<string>(user.id, 'totp', user.mfa_secret);

      const step = verifyTotp(
        secret,
        code,
        user.mfa_last_step === null ? null : Number(user.mfa_last_step),
      );

      if (step !== null) {
        await tx.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [user.id, step]);

        return true;
      }
    } else if (/^[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}$/i.test(code)) {
      const result = await tx.query(
        'DELETE FROM mfa_recovery_codes WHERE user_id=$1 AND code_hash=$2',
        [user.id, sha256(`${user.id}:${code.toLowerCase()}`)],
      );

      if (result.rowCount) {
        await accountAudit(tx, user.id, 'account.recovery_code_used');

        return true;
      }
    }

    return false;
  }

  async recoveryCodes(tx: Transaction, userId: string) {
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(12).toString('hex').match(/.{8}/g)!.join('-'),
    );

    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);

    for (const code of codes) {
      await tx.query('INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)', [
        userId,
        sha256(`${userId}:${code}`),
      ]);
    }

    return codes;
  }

  async completeLogin(req: FastifyRequest, challenge: string, code: string) {
    const db = this.identity.control.db;

    const found = (
      await db.query('SELECT user_id FROM mfa_challenges WHERE token_hash=$1', [sha256(challenge)])
    ).rows[0];

    if (!found) {
      throw invalidCode();
    }

    await this.budget(found.user_id);

    const token = await transaction(db, async (tx) => {
      const user = (
        await tx.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [found.user_id])
      ).rows[0];

      const attempt = (
        await tx.query(
          `
            UPDATE mfa_challenges
            SET
              attempts = attempts + 1
            WHERE
              token_hash = $1
              AND expires_at > now()
              AND attempts < 5
            RETURNING
              user_id
          `,
          [sha256(challenge)],
        )
      ).rows[0];

      if (!attempt || !(await this.consume(tx, user, code))) {
        // Return instead of throwing so the failed-attempt count commits.
        return null;
      }

      await tx.query('DELETE FROM mfa_challenges WHERE token_hash=$1', [sha256(challenge)]);
      await accountAudit(tx, user.id, 'account.mfa_signed_in');

      return this.identity.issueSession(tx, user.id, req, true);
    });

    if (!token) {
      throw invalidCode();
    }

    return token;
  }

  async withSession<T>(
    req: FastifyRequest,
    work: (
      tx: Transaction,
      user: {
        id: string;
        email: string;
        password_hash: string;
        mfa_secret: unknown;
        mfa_last_step: string | null;
        mfa_enabled_at: string | null;
      },
      session: NonNullable<Awaited<ReturnType<Identity['session']>>>,
    ) => Promise<T>,
    password?: string,
  ) {
    const session = (await this.identity.session(req))!;
    const db = this.identity.control.db;
    let passwordHash: string | undefined;

    if (password !== undefined) {
      await this.budget(session.user_id);

      passwordHash = (
        await db.query('SELECT password_hash FROM users WHERE id=$1', [session.user_id])
      ).rows[0].password_hash;

      if (!(await verifyPassword(password, passwordHash))) {
        throw new DomainError('INVALID_PASSWORD', 'Current password is incorrect.', 403);
      }
    }

    return transaction(db, async (tx) => {
      const user = (
        await tx.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [session.user_id])
      ).rows[0];

      const valid = await tx.query(
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
            AND (
              $2::boolean = FALSE
              OR mfa_verified
            )
        `,
        [session.session_id, !!user.mfa_secret],
      );

      if (!valid.rowCount || (passwordHash && user.password_hash !== passwordHash)) {
        throw unauthenticated();
      }

      return work(tx, user, session);
    });
  }

  async register(app: FastifyInstance) {
    const identity = this.identity;
    const limited = { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };

    app.get('/api/auth/security', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');

      return this.withSession(req, async (tx, user, session) => {
        const sessions = (
          await tx.query(
            `
              SELECT
                id,
                created_at,
                last_seen_at,
                expires_at,
                user_agent,
                ip_address,
                id = $2 AS current,
                mfa_verified
              FROM
                browser_sessions
              WHERE
                user_id = $1
                AND revoked_at IS NULL
                AND expires_at > now()
                AND last_seen_at > now() - interval '1 hour'
              ORDER BY
                created_at DESC,
                id DESC
              LIMIT
                25
            `,
            [user.id, session.session_id],
          )
        ).rows;

        const recovery = (
          await tx.query('SELECT count(*)::int AS count FROM mfa_recovery_codes WHERE user_id=$1', [
            user.id,
          ])
        ).rows[0];

        return {
          mfa_enabled: !!user.mfa_secret,
          enabled_at: user.mfa_enabled_at,
          recovery_codes_remaining: recovery.count,
          sessions,
        };
      });
    });

    await app.register(
      async (auth) => {
        auth.addHook('onRequest', async (req, reply) => {
          reply.header('Cache-Control', 'no-store');
          identity.checkOrigin(req);
        });

        auth.post('/challenge', limited, async (req, reply) => {
          const input = z
            .object({ challenge: z.string().regex(/^[a-zA-Z0-9_-]{43}$/), code: codeInput })
            .strict()
            .parse(req.body);

          const token = await this.completeLogin(req, input.challenge, input.code);

          reply.header('Set-Cookie', identity.cookie(token));

          return { signed_in: true };
        });

        auth.post('/enroll', limited, async (req) => {
          const input = passwordProof.parse(req.body);

          return this.withSession(
            req,
            async (tx, user, session) => {
              if (user.mfa_secret) {
                throw new DomainError('MFA_ENABLED', 'MFA is already enabled.', 409);
              }

              const secret = newTotpSecret();
              const encrypted = mfaVault().encrypt(user.id, 'totp', secret);

              await tx.query(
                `
                  INSERT INTO
                    mfa_enrollments (user_id, session_id, secret, expires_at)
                  VALUES
                    ($1, $2, $3, now() + interval '10 minutes')
                  ON CONFLICT (user_id) DO UPDATE
                  SET
                    session_id = excluded.session_id,
                    secret = excluded.secret,
                    expires_at = excluded.expires_at
                `,
                [user.id, session.session_id, encrypted],
              );

              const key = base32(Buffer.from(secret, 'base64'));

              return {
                secret: key,
                uri: `otpauth://totp/${encodeURIComponent(`Keel:${user.email}`)}?secret=${key}&issuer=Keel&algorithm=SHA1&digits=6&period=30`,
              };
            },
            input.current_password,
          );
        });

        auth.post('/cancel', limited, async (req) => {
          z.object({}).strict().parse(req.body);

          return this.withSession(req, async (tx, user, session) => {
            await tx.query('DELETE FROM mfa_enrollments WHERE user_id=$1 AND session_id=$2', [
              user.id,
              session.session_id,
            ]);

            return { cancelled: true };
          });
        });

        auth.post('/confirm', limited, async (req, reply) => {
          const input = z
            .object({ code: z.string().regex(/^\d{6}$/) })
            .strict()
            .parse(req.body);

          const session = (await identity.session(req))!;

          await this.budget(session.user_id);

          const result = await this.withSession(req, async (tx, user) => {
            const enrollment = (
              await tx.query(
                `
                  SELECT
                    secret
                  FROM
                    mfa_enrollments
                  WHERE
                    user_id = $1
                    AND session_id = $2
                    AND expires_at > now()
                `,
                [user.id, session.session_id],
              )
            ).rows[0];

            if (user.mfa_secret || !enrollment) {
              throw new DomainError('ENROLLMENT_EXPIRED', 'Start authenticator setup again.', 409);
            }

            const secret = mfaVault().decrypt<string>(user.id, 'totp', enrollment.secret);
            const step = verifyTotp(secret, input.code, null);

            if (step === null) {
              throw invalidCode();
            }

            await tx.query(
              'UPDATE users SET mfa_secret=$2,mfa_enabled_at=now(),mfa_last_step=$3 WHERE id=$1',
              [user.id, enrollment.secret, step],
            );

            await revokeAccountCredentials(tx, user.id);
            const token = await identity.issueSession(tx, user.id, req, true);

            const codes = await this.recoveryCodes(tx, user.id);

            await accountAudit(tx, user.id, 'account.mfa_enabled');

            return { recovery_codes: codes, token };
          });

          reply.header('Set-Cookie', identity.cookie(result.token));

          return { recovery_codes: result.recovery_codes, csrf: identity.csrf(result.token) };
        });

        for (const action of ['disable', 'recovery-codes'] as const) {
          auth.post(`/${action}`, limited, async (req, reply) => {
            const input = factorProof.parse(req.body);

            const result = await this.withSession(
              req,
              async (tx, user) => {
                if (!(await this.consume(tx, user, input.code))) {
                  throw invalidCode();
                }

                if (action === 'disable') {
                  await tx.query(
                    'UPDATE users SET mfa_secret=NULL,mfa_enabled_at=NULL,mfa_last_step=NULL WHERE id=$1',
                    [user.id],
                  );

                  await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [user.id]);
                  await revokeAccountCredentials(tx, user.id);
                  await accountAudit(tx, user.id, 'account.mfa_disabled');

                  return { disabled: true };
                }

                const codes = await this.recoveryCodes(tx, user.id);

                await accountAudit(tx, user.id, 'account.recovery_codes_replaced');

                return { recovery_codes: codes };
              },
              input.current_password,
            );

            if (action === 'disable') {
              reply.header('Set-Cookie', identity.cookie('', true));
            }

            return result;
          });
        }
      },
      { prefix: '/api/auth/mfa' },
    );

    app.post('/api/auth/sessions/revoke', async (req, reply) => {
      const input = z
        .union([
          z.object({ id: z.string().uuid() }).strict(),
          z.object({ others: z.literal(true) }).strict(),
        ])
        .parse(req.body);

      const result = await this.withSession(req, async (tx, user, session) => {
        const id = 'id' in input ? input.id : null;

        const revoked = await tx.query(
          `
            UPDATE browser_sessions
            SET
              revoked_at = now()
            WHERE
              user_id = $1
              AND revoked_at IS NULL
              AND (
                (
                  $2::uuid IS NOT NULL
                  AND id = $2
                )
                OR (
                  $2::uuid IS NULL
                  AND id <> $3
                )
              )
            RETURNING
              id
          `,
          [user.id, id, session.session_id],
        );

        if (id && !revoked.rowCount) {
          throw new DomainError('NOT_FOUND', 'Active session not found.', 404);
        }

        await accountAudit(tx, user.id, 'account.sessions_revoked', { count: revoked.rowCount });

        return { signed_out: id === session.session_id, revoked: revoked.rowCount };
      });

      reply.header('Cache-Control', 'no-store');

      if (result.signed_out) {
        reply.header('Set-Cookie', identity.cookie('', true));
      }

      return result;
    });
  }
}
