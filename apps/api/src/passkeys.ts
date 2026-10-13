import { isIP } from 'node:net';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transaction } from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { Identity, newOpaque, opaqueInput } from './identity.js';
import { sha256 } from './artifact-store.js';
import { accountAudit, revokeAccountCredentials } from './account-security.js';

const invalid = () =>
  new DomainError('PASSKEY_INVALID', 'Passkey verification failed. Start again.', 400);

const empty = z.object({}).strict();
const password = z.string().min(1).max(128);

const credentialId = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);

const responseInput = z
  .object({
    id: credentialId,
    rawId: credentialId,
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  })
  .strict()
  .refine((value) => value.id === value.rawId);

export class Passkeys {
  readonly rpId: string;
  readonly cookieName: string;

  constructor(readonly identity: Identity) {
    this.rpId = new URL(identity.origin).hostname;
    this.cookieName = identity.secure ? '__Host-keel_passkey' : 'keel_passkey';
  }

  assertSupported() {
    if (isIP(this.rpId.replace(/^\[|\]$/g, ''))) {
      throw new DomainError(
        'PASSKEY_UNAVAILABLE',
        'Passkeys require a hostname. Use HTTPS with a domain, or localhost for development.',
        400,
      );
    }
  }

  cookie(token: string, clear = false) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 300}${this.identity.secure ? '; Secure' : ''}`;
  }

  cookieToken(req: FastifyRequest) {
    const matches = (req.headers.cookie || '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${this.cookieName}=`));

    const token = matches.length === 1 ? matches[0].slice(this.cookieName.length + 1) : '';

    return opaqueInput.safeParse(token).success ? token : '';
  }

  async consumeAttempt(token: string, sessionId?: string) {
    // Consume outside verification's transaction: a rejected assertion cannot replay the challenge.
    const result = await this.identity.control.db.query(
      `
        DELETE FROM passkey_attempts
        WHERE
          token_hash = $1
          AND expires_at > now()
          AND session_id IS NOT DISTINCT FROM $2::uuid
        RETURNING
          *
      `,
      [sha256(token), sessionId ?? null],
    );

    if (!result.rows[0]) {
      throw invalid();
    }

    return result.rows[0];
  }

  async register(app: FastifyInstance) {
    const identity = this.identity;
    const db = identity.control.db;

    const limited = {
      bodyLimit: 65536,
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    };

    await app.register(
      async (auth) => {
        auth.addHook('onRequest', async (req, reply) => {
          reply.header('Cache-Control', 'no-store');
          identity.checkOrigin(req);
        });

        auth.post('/enroll', limited, async (req) => {
          this.assertSupported();

          const input = z
            .object({ name: z.string().trim().min(1).max(100), current_password: password })
            .strict()
            .parse(req.body);

          return identity.security.withSession(
            req,
            async (tx, user, session) => {
              const existing = (
                await tx.query('SELECT id,transports FROM passkeys WHERE user_id=$1', [user.id])
              ).rows;

              if (existing.length >= 10) {
                throw new DomainError(
                  'PASSKEY_LIMIT',
                  'Remove a passkey before adding another. The limit is 10.',
                  409,
                );
              }

              const options = await generateRegistrationOptions({
                rpName: 'Keel',
                rpID: this.rpId,
                userID: new Uint8Array(Buffer.from(user.id)),
                userName: user.email,
                attestationType: 'none',
                excludeCredentials: existing,
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
                supportedAlgorithmIDs: [-7, -257],
              });

              const attempt = newOpaque();

              await tx.query('DELETE FROM passkey_attempts WHERE user_id=$1 OR expires_at<=now()', [
                user.id,
              ]);

              await tx.query(
                `
                  INSERT INTO
                    passkey_attempts (
                      token_hash,
                      challenge_hash,
                      user_id,
                      session_id,
                      name
                    )
                  VALUES
                    ($1, $2, $3, $4, $5)
                `,
                [
                  sha256(attempt),
                  sha256(options.challenge),
                  user.id,
                  session.session_id,
                  input.name,
                ],
              );

              return { attempt, options };
            },
            input.current_password,
          );
        });

        auth.post('/confirm', limited, async (req) => {
          const input = z
            .object({ attempt: opaqueInput, response: responseInput })
            .strict()
            .parse(req.body);

          const session = (await identity.session(req))!;
          const attempt = await this.consumeAttempt(input.attempt, session.session_id);

          return identity.security.withSession(req, async (tx, user) => {
            let result;

            try {
              const client = decodeClientDataJSON(String(input.response.response.clientDataJSON));

              if (client.crossOrigin || client.topOrigin) {
                throw invalid();
              }

              result = await verifyRegistrationResponse({
                response: input.response as unknown as RegistrationResponseJSON,
                expectedChallenge: (challenge) => sha256(challenge) === attempt.challenge_hash,
                expectedOrigin: identity.origin,
                expectedRPID: this.rpId,
                requireUserVerification: true,
                supportedAlgorithmIDs: [-7, -257],
              });
            } catch {
              throw invalid();
            }

            if (!result.verified || !result.registrationInfo || attempt.user_id !== user.id) {
              throw invalid();
            }

            const count = (
              await tx.query('SELECT count(*)::int AS count FROM passkeys WHERE user_id=$1', [
                user.id,
              ])
            ).rows[0].count;

            if (count >= 10) {
              throw new DomainError(
                'PASSKEY_LIMIT',
                'Remove a passkey before adding another. The limit is 10.',
                409,
              );
            }

            const { credential, credentialBackedUp, credentialDeviceType } =
              result.registrationInfo;

            if (credential.id !== input.response.id) {
              throw invalid();
            }

            const inserted = await tx.query(
              `
                INSERT INTO
                  passkeys (
                    id,
                    user_id,
                    name,
                    public_key,
                    counter,
                    transports,
                    backed_up,
                    device_type
                  )
                VALUES
                  ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (id) DO NOTHING
              `,
              [
                credential.id,
                user.id,
                attempt.name,
                Buffer.from(credential.publicKey),
                credential.counter,
                credential.transports ?? [],
                credentialBackedUp,
                credentialDeviceType,
              ],
            );

            if (!inserted.rowCount) {
              throw new DomainError('PASSKEY_EXISTS', 'This passkey is already registered.', 409);
            }

            await accountAudit(tx, user.id, 'account.passkey_added', { name: attempt.name });

            return { added: true };
          });
        });

        auth.post('/remove', limited, async (req, reply) => {
          const input = z
            .object({ id: credentialId, current_password: password })
            .strict()
            .parse(req.body);

          await identity.security.withSession(
            req,
            async (tx, user) => {
              const removed = await tx.query(
                'DELETE FROM passkeys WHERE id=$1 AND user_id=$2 RETURNING name',
                [input.id, user.id],
              );

              if (!removed.rowCount) {
                throw new DomainError('NOT_FOUND', 'Passkey not found.', 404);
              }

              await revokeAccountCredentials(tx, user.id);

              await accountAudit(tx, user.id, 'account.passkey_removed', {
                name: removed.rows[0].name,
              });
            },
            input.current_password,
          );

          reply.header('Set-Cookie', identity.cookie('', true));

          return { signed_out: true };
        });

        auth.post('/options', limited, async (req, reply) => {
          this.assertSupported();
          empty.parse(req.body);

          const options = await generateAuthenticationOptions({
            rpID: this.rpId,
            userVerification: 'required',
          });

          const token = newOpaque();
          const previous = this.cookieToken(req);

          await db.query('DELETE FROM passkey_attempts WHERE expires_at<=now() OR token_hash=$1', [
            sha256(previous),
          ]);

          await db.query('INSERT INTO passkey_attempts(token_hash,challenge_hash) VALUES($1,$2)', [
            sha256(token),
            sha256(options.challenge),
          ]);

          reply.header('Set-Cookie', this.cookie(token));

          return { options };
        });

        auth.post('/login', limited, async (req, reply) => {
          const input = z.object({ response: responseInput }).strict().parse(req.body);
          const attempt = await this.consumeAttempt(this.cookieToken(req));

          reply.header('Set-Cookie', this.cookie('', true));

          const found = (
            await db.query('SELECT user_id FROM passkeys WHERE id=$1', [input.response.id])
          ).rows[0];

          if (!found) {
            throw invalid();
          }

          await identity.attemptBudget(`passkey:${found.user_id}`);

          const result = await transaction(db, async (tx) => {
            const user = (
              await tx.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [found.user_id])
            ).rows[0];

            const key = (
              await tx.query('SELECT * FROM passkeys WHERE id=$1 AND user_id=$2', [
                input.response.id,
                user.id,
              ])
            ).rows[0];

            if (
              !key ||
              input.response.response.userHandle !== Buffer.from(user.id).toString('base64url')
            ) {
              throw invalid();
            }

            let verified;

            try {
              const client = decodeClientDataJSON(String(input.response.response.clientDataJSON));

              if (client.crossOrigin || client.topOrigin) {
                throw invalid();
              }

              verified = await verifyAuthenticationResponse({
                response: input.response as unknown as AuthenticationResponseJSON,
                expectedChallenge: (challenge) => sha256(challenge) === attempt.challenge_hash,
                expectedOrigin: identity.origin,
                expectedRPID: this.rpId,
                requireUserVerification: true,
                credential: {
                  id: key.id,
                  publicKey: new Uint8Array(key.public_key),
                  counter: Number(key.counter),
                  transports: key.transports,
                },
              });
            } catch {
              throw invalid();
            }

            if (
              !verified.verified ||
              verified.authenticationInfo.credentialDeviceType !== key.device_type
            ) {
              throw invalid();
            }

            await tx.query(
              'UPDATE passkeys SET counter=$2,backed_up=$3,last_used_at=now() WHERE id=$1',
              [
                key.id,
                verified.authenticationInfo.newCounter,
                verified.authenticationInfo.credentialBackedUp,
              ],
            );

            if (user.mfa_secret) {
              const challenge = newOpaque();

              await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1 OR expires_at<=now()', [
                user.id,
              ]);

              await tx.query(
                `
                  INSERT INTO
                    mfa_challenges (token_hash, user_id, expires_at, passkey_id)
                  VALUES
                    ($1, $2, now() + interval '5 minutes', $3)
                `,
                [sha256(challenge), user.id, key.id],
              );

              return { mfa_required: true, challenge };
            }

            await accountAudit(tx, user.id, 'account.passkey_signed_in');

            return { token: await identity.issueSession(tx, user.id, req) };
          });

          if (result.token) {
            reply.header('Set-Cookie', [this.cookie('', true), identity.cookie(result.token)]);

            return { signed_in: true };
          }

          reply.header('Set-Cookie', [this.cookie('', true), identity.cookie('', true)]);

          return { mfa_required: true, challenge: result.challenge };
        });
      },
      { prefix: '/api/auth/passkeys' },
    );
  }
}
