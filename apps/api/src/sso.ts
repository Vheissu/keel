import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { transaction, type Database } from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import type { Identity } from './identity.js';
import { newOpaque, opaqueInput } from './identity.js';
import { CredentialVault } from './credential-vault.js';
import { sha256 } from './artifact-store.js';
import { accountAudit } from './account-security.js';

export const ssoConfigurationInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    issuer: z.string().url().max(2048),
    authorization_endpoint: z.string().url().max(2048),
    token_endpoint: z.string().url().max(2048),
    jwks_uri: z.string().url().max(2048),
    client_id: z.string().min(1).max(512),
    client_secret: z.string().min(1).max(4096),
  })
  .strict();

type Configuration = z.infer<typeof ssoConfigurationInput>;

const failed = () =>
  new DomainError(
    'SSO_FAILED',
    'SSO could not be completed. Connect your account from a password session first, then try again.',
    403,
  );

export function ssoVault() {
  if (!process.env.KEEL_CREDENTIAL_KEY) {
    throw new DomainError('SSO_UNAVAILABLE', 'SSO requires the server credential key.', 503);
  }

  return new CredentialVault(process.env.KEEL_CREDENTIAL_KEY, 'sso');
}

export function validateSsoConfiguration(input: unknown, origin: string) {
  const config = ssoConfigurationInput.parse(input);

  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const url = new URL(config[key]);

    const local =
      origin.startsWith('http:') &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

    if (
      (url.protocol !== 'https:' && !local) ||
      url.username ||
      url.password ||
      url.hash ||
      (key === 'issuer' && url.search)
    ) {
      throw new Error(
        'SSO endpoints must use HTTPS without credentials or fragments. Loopback HTTP is allowed only with an HTTP development origin.',
      );
    }
  }

  return config;
}

export async function configureSso(
  db: Database,
  organisation: string,
  input: unknown,
  origin: string,
) {
  const config = validateSsoConfiguration(input, origin);
  const id = randomUUID();
  const encrypted = ssoVault().encrypt(organisation, id, config);

  await transaction(db, async (tx) => {
    const workspace = await tx.query('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE', [
      organisation,
    ]);

    if (!workspace.rowCount) {
      throw new Error('Workspace not found.');
    }

    // Replacing a provider retires its subject mappings and browser proofs permanently.
    await tx.query(
      `
        UPDATE browser_sessions
        SET
          revoked_at = now()
        WHERE
          sso_connection_id IN (
            SELECT
              id
            FROM
              sso_connections
            WHERE
              organisation_id = $1
          )
          AND revoked_at IS NULL
      `,
      [organisation],
    );

    await tx.query('DELETE FROM sso_connections WHERE organisation_id=$1', [organisation]);

    await tx.query(
      `
        INSERT INTO
          sso_connections (organisation_id, id, name, configuration)
        VALUES
          ($1, $2, $3, $4)
      `,
      [organisation, id, config.name, encrypted],
    );

    await tx.query(
      'UPDATE workspace_auth_policies SET require_sso=false WHERE organisation_id=$1',
      [organisation],
    );

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
      [organisation],
    );

    const actor = randomUUID();

    await tx.query("INSERT INTO actors(id,organisation_id,name) VALUES($1,$2,'Server operator')", [
      actor,
      organisation,
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
        VALUES
          ($1, $2, $3, 'workspace.sso_configured', $4, '{}')
      `,
      [randomUUID(), organisation, actor, id],
    );
  });

  return {
    configured: true,
    workspace_id: organisation,
    callback_url: `${origin}/api/auth/sso/callback`,
  };
}

export class Sso {
  constructor(readonly identity: Identity) {}

  cookie(value: string, clear = false) {
    return `${this.identity.secure ? '__Host-' : ''}keel_sso=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${this.identity.secure ? '; Secure' : ''}`;
  }

  binding(req: FastifyRequest) {
    const prefix = `${this.identity.secure ? '__Host-' : ''}keel_sso=`;

    const matches = (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(prefix));

    return matches.length === 1 ? matches[0].slice(prefix.length) : '';
  }

  configuration(row: { organisation_id: string; id: string; configuration: unknown }) {
    const config = validateSsoConfiguration(
      ssoVault().decrypt<Configuration>(row.organisation_id, row.id, row.configuration),
      this.identity.origin,
    );

    const client = new oidc.Configuration(
      {
        issuer: config.issuer,
        authorization_endpoint: config.authorization_endpoint,
        token_endpoint: config.token_endpoint,
        jwks_uri: config.jwks_uri,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
      },
      config.client_id,
      { client_secret: config.client_secret, id_token_signed_response_alg: 'RS256' },
      oidc.ClientSecretPost(config.client_secret),
    );

    if (!this.identity.secure) {
      oidc.allowInsecureRequests(client);
    }

    oidc.enableNonRepudiationChecks(client);
    client.timeout = 10;

    client[oidc.customFetch] = (url, options) =>
      fetch(url, {
        ...options,
        body: options.body as BodyInit | undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });

    return client;
  }

  async start(req: FastifyRequest, organisation: string, link: boolean) {
    this.identity.checkOrigin(req);
    const session = link ? await this.identity.session(req) : null;
    const db = this.identity.control.db;

    const row = (
      await db.query('SELECT * FROM sso_connections WHERE organisation_id=$1', [organisation])
    ).rows[0];

    if (!row) {
      throw failed();
    }

    if (session) {
      // Only a local account session may establish a new provider binding.
      const member = await db.query(
        `
          SELECT
            1
          FROM
            memberships
          WHERE
            organisation_id = $1
            AND user_id = $2
            AND removed_at IS NULL
        `,
        [organisation, session.user_id],
      );

      if (!member.rowCount || session.sso_connection_id) {
        throw failed();
      }
    }

    const config = this.configuration(row);
    const state = newOpaque();
    const binding = newOpaque();
    const nonce = newOpaque();
    const verifier = oidc.randomPKCECodeVerifier();

    const redirect = oidc.buildAuthorizationUrl(config, {
      redirect_uri: `${this.identity.origin}/api/auth/sso/callback`,
      scope: 'openid email',
      response_type: 'code',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'login',
      max_age: '0',
    });

    await db.query('DELETE FROM sso_attempts WHERE expires_at<=now()', []);

    await db.query(
      `
        INSERT INTO
          sso_attempts (
            state_hash,
            binding_hash,
            connection_id,
            proof,
            session_id,
            expires_at
          )
        VALUES
          ($1, $2, $3, $4, $5, now() + interval '10 minutes')
      `,
      [
        sha256(state),
        sha256(binding),
        row.id,
        ssoVault().encrypt(row.organisation_id, row.id, { nonce, verifier }),
        session?.session_id || null,
      ],
    );

    return { url: redirect.href, binding };
  }

  async finish(req: FastifyRequest) {
    const url = new URL(req.url, this.identity.origin);
    const state = opaqueInput.parse(url.searchParams.get('state'));
    const binding = opaqueInput.parse(this.binding(req));
    const db = this.identity.control.db;

    // Consume the browser-bound attempt before any network request, including failed callbacks.
    const attempt = (
      await db.query(
        `
          DELETE FROM sso_attempts
          WHERE
            state_hash = $1
            AND binding_hash = $2
            AND expires_at > now()
          RETURNING
            *
        `,
        [sha256(state), sha256(binding)],
      )
    ).rows[0];

    if (!attempt) {
      throw failed();
    }

    const row = (
      await db.query('SELECT * FROM sso_connections WHERE id=$1', [attempt.connection_id])
    ).rows[0];

    if (!row) {
      throw failed();
    }

    const proof = ssoVault().decrypt<{ nonce: string; verifier: string }>(
      row.organisation_id,
      row.id,
      attempt.proof,
    );

    const tokens = await oidc.authorizationCodeGrant(this.configuration(row), url, {
      expectedState: state,
      expectedNonce: proof.nonce,
      pkceCodeVerifier: proof.verifier,
      idTokenExpected: true,
      maxAge: 60,
    });

    const claims = tokens.claims();

    if (
      !claims ||
      typeof claims.sub !== 'string' ||
      !claims.sub.length ||
      claims.sub.length > 255 ||
      claims.email_verified !== true ||
      typeof claims.email !== 'string'
    ) {
      throw failed();
    }

    const email = claims.email.trim().toLowerCase();

    return transaction(db, async (tx) => {
      await tx.query('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE', [
        row.organisation_id,
      ]);

      const current = await tx.query('SELECT id FROM sso_connections WHERE id=$1', [row.id]);

      if (!current.rowCount) {
        throw failed();
      }

      const linked = (
        await tx.query('SELECT user_id FROM sso_identities WHERE connection_id=$1 AND subject=$2', [
          row.id,
          claims.sub,
        ])
      ).rows[0];

      const linking = attempt.session_id
        ? (await tx.query('SELECT user_id FROM browser_sessions WHERE id=$1', [attempt.session_id]))
            .rows[0]
        : null;

      const userId = linking?.user_id || linked?.user_id;

      if (!userId) {
        throw failed();
      }

      const user = (await tx.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [userId]))
        .rows[0];

      const member = await tx.query(
        `
          SELECT
            1
          FROM
            memberships
          WHERE
            organisation_id = $1
            AND user_id = $2
            AND removed_at IS NULL
        `,
        [row.organisation_id, userId],
      );

      if (!member.rowCount || user.email !== email) {
        throw failed();
      }

      if (attempt.session_id) {
        // Revalidate the original local session, not whichever cookie arrived on the callback.
        const valid = await tx.query(
          `
            SELECT
              1
            FROM
              browser_sessions
            WHERE
              id = $1
              AND user_id = $2
              AND sso_connection_id IS NULL
              AND revoked_at IS NULL
              AND expires_at > now()
              AND last_seen_at > now() - interval '1 hour'
              AND (
                $3::boolean = FALSE
                OR mfa_verified
              )
          `,
          [attempt.session_id, userId, !!user.mfa_secret],
        );

        if (!valid.rowCount || (linked && linked.user_id !== userId)) {
          throw failed();
        }

        await tx.query(
          `
            INSERT INTO
              sso_identities (connection_id, subject, user_id)
            VALUES
              ($1, $2, $3)
            ON CONFLICT (connection_id, subject) DO NOTHING
          `,
          [row.id, claims.sub, userId],
        );

        await accountAudit(tx, userId, 'account.sso_connected', {
          workspace_id: row.organisation_id,
        });

        return { linked: true };
      }

      if (user.mfa_secret) {
        const challenge = newOpaque();

        await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1', [userId]);

        await tx.query(
          `
            INSERT INTO
              mfa_challenges (
                token_hash,
                user_id,
                expires_at,
                sso_connection_id
              )
            VALUES
              ($1, $2, now() + interval '5 minutes', $3)
          `,
          [sha256(challenge), userId, row.id],
        );

        return { challenge };
      }

      await accountAudit(tx, userId, 'account.sso_signed_in', {
        workspace_id: row.organisation_id,
      });

      return { token: await this.identity.issueSession(tx, userId, req, false, row.id) };
    });
  }

  async register(app: FastifyInstance) {
    const limited = { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };

    app.post('/api/auth/sso/start', limited, async (req, reply) => {
      const input = z
        .object({ workspace_id: z.string().uuid(), link: z.boolean().default(false) })
        .strict()
        .parse(req.body);

      const result = await this.start(req, input.workspace_id, input.link);

      reply.header('Cache-Control', 'no-store').header('Set-Cookie', this.cookie(result.binding));

      return { url: result.url };
    });

    app.get('/api/auth/sso/callback', limited, async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      const cookies = [this.cookie('', true)];
      let hash = '#sso?error=failed';

      try {
        const result = await this.finish(req);

        if (result.token) {
          cookies.push(this.identity.cookie(result.token));
          hash = '#overview';
        } else if (result.challenge) {
          // End the prior local session in this browser while the MFA challenge is pending.
          cookies.push(this.identity.cookie('', true));
          hash = `#sso?challenge=${result.challenge}`;
        } else {
          hash = '#sso?linked=1';
        }
      } catch {
        // Provider errors can contain tokens or personal data. Never echo or log them.
      }

      reply.header('Set-Cookie', cookies);

      return reply.redirect(`${this.identity.origin}/${hash}`);
    });
  }
}
