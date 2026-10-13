import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../../packages/database/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { identityAdmin } from '../../apps/operations/src/identity-admin.js';
import { configureSso, validateSsoConfiguration, ssoVault } from '../../apps/api/src/sso.js';
import { fixture, testDatabaseUrl } from '../fixtures.js';
import { oidcProvider } from '../oidc-provider.js';
import { mfaVault } from '../../apps/api/src/account-security.js';
import { totp, newTotpSecret } from '../../apps/api/src/totp.js';
import { lockPrincipal } from '../../apps/api/src/identity-policy.js';
import { transaction } from '../../packages/database/src/index.js';

const schema = `sso_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const origin = 'http://127.0.0.1:5174';
const password = 'a long and memorable password';
let app: FastifyInstance;
let root: string;
let provider: Awaited<ReturnType<typeof oidcProvider>>;
let workspace: string;
let email: string;
let ip = 0;

type Session = { cookie: string; csrf: string; userId: string };

let owner: Session;

const defaults = {
  require_sso: false,
  require_mfa: false,
  allow_api_tokens: true,
  session_minutes: 720,
};

beforeAll(async () => {
  process.env.KEEL_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-sso-'));

  app = await createApp(
    new ControlPlane(db, new LocalArtifactStore(root)),
    false,
    undefined,
    undefined,
    origin,
  );

  provider = await oidcProvider();
});

beforeEach(async () => {
  workspace = (await fixture(db)).org;
  email = `owner-${randomUUID()}@example.com`;
  const provisioned = await identityAdmin(db, ['invite-owner', workspace, email], origin);
  const token = new URL(provisioned.link!).hash.split('token=')[1];
  const response = await auth('/accept', { token, name: 'Owner', password });

  expect(response.statusCode, response.body).toBe(200);
  owner = await session(response.headers['set-cookie'] as string);
  provider.state.email = email;
  provider.state.subject = `subject-${randomUUID()}`;
  provider.state.invalid = '';
  provider.state.verified = true;
  await configureSso(db, workspace, provider.config, origin);
});

afterAll(async () => {
  await app?.close();
  await provider?.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

function auth(path: string, payload: object, signedIn?: Session) {
  return app.inject({
    method: 'POST',
    url: `/api/auth${path}`,
    payload,
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: {
      origin,
      ...(signedIn ? { cookie: signedIn.cookie, 'x-csrf-token': signedIn.csrf } : {}),
    },
  });
}

function api(path: string, payload?: object, signedIn = owner, organisation = workspace) {
  return app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url: `/api/v1${path}`,
    payload,
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: {
      origin,
      cookie: signedIn.cookie,
      'x-csrf-token': signedIn.csrf,
      'x-workspace-id': organisation,
      'idempotency-key': randomUUID(),
    },
  });
}

async function session(cookie: string): Promise<Session> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie: cookie.split(';')[0] },
  });

  expect(response.json().user).toBeTruthy();

  return {
    cookie: cookie.split(';')[0],
    csrf: response.json().csrf,
    userId: response.json().user.id,
  };
}

async function start(link = false, signedIn = owner) {
  const response = await auth(
    '/sso/start',
    { workspace_id: workspace, link },
    link ? signedIn : undefined,
  );

  expect(response.statusCode, response.body).toBe(200);

  return {
    url: provider.authorize(response.json().url),
    cookie: (response.headers['set-cookie'] as string).split(';')[0],
  };
}

function finish(attempt: { url: string; cookie: string }) {
  return app.inject({
    method: 'GET',
    url: new URL(attempt.url).pathname + new URL(attempt.url).search,
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: { cookie: attempt.cookie },
  });
}

async function connect() {
  const response = await finish(await start(true));

  expect(response.headers.location).toBe(`${origin}/#sso?linked=1`);
}

async function signIn() {
  const response = await finish(await start());

  expect(response.headers.location).toBe(`${origin}/#overview`);
  const cookies = response.headers['set-cookie'] as string[];

  return session(cookies.find((value) => value.startsWith('keel_session='))!);
}

it('links explicitly and signs in using a signed ID token, PKCE and a browser-bound callback', async () => {
  const unlinked = await finish(await start());

  expect(unlinked.headers.location).toContain('error=failed');
  expect((await db.query('SELECT count(*) FROM sso_identities')).rows[0].count).toBe('0');
  await connect();
  const signedIn = await signIn();

  expect(signedIn.userId).toBe(owner.userId);
  expect((await api('/snapshot', undefined, signedIn)).statusCode).toBe(200);

  const configured = (
    await db.query('SELECT * FROM sso_connections WHERE organisation_id=$1', [workspace])
  ).rows[0];

  expect(JSON.stringify(configured)).not.toContain('provider-secret');

  expect(ssoVault().decrypt(workspace, configured.id, configured.configuration)).toEqual(
    provider.config,
  );

  const metadata = await app.inject({
    url: '/api/auth/session',
    headers: { cookie: signedIn.cookie },
  });

  expect(metadata.json().sso_workspace).toBe(workspace);
  expect(metadata.body).not.toContain('provider-secret');
});

it.each(['nonce', 'issuer', 'audience', 'signature', 'expired', 'email', 'auth_time'] as const)(
  'rejects invalid %s without issuing a session',
  async (invalid) => {
    await connect();
    provider.state.invalid = invalid;
    const response = await finish(await start());

    expect(response.headers.location).toContain('error=failed');
    expect(JSON.stringify(response.headers['set-cookie'])).not.toContain('keel_session=');
  },
);

it('rejects unverified email and cannot silently replace a linked subject', async () => {
  provider.state.verified = false;
  expect((await finish(await start(true))).headers.location).toContain('error=failed');
  provider.state.verified = true;
  await connect();
  provider.state.subject = 'other-subject';
  expect((await finish(await start(true))).headers.location).toContain('error=failed');
  expect((await finish(await start())).headers.location).toContain('error=failed');
});

it('rejects missing browser binding, altered state, expiration and replay', async () => {
  await connect();
  const attempt = await start();
  const count = provider.state.tokenRequests;

  expect((await finish({ ...attempt, cookie: '' })).headers.location).toContain('error=failed');
  const changed = new URL(attempt.url);

  changed.searchParams.set('state', 'a'.repeat(43));

  expect((await finish({ ...attempt, url: changed.href })).headers.location).toContain(
    'error=failed',
  );

  expect(provider.state.tokenRequests).toBe(count);
  expect((await finish(attempt)).headers.location).toContain('#overview');
  expect((await finish(attempt)).headers.location).toContain('error=failed');
  expect(provider.state.tokenRequests).toBe(count + 1);
  const expired = await start();

  await db.query("UPDATE sso_attempts SET expires_at=now()-interval '1 second'");
  expect((await finish(expired)).headers.location).toContain('error=failed');
});

it('requires local session CSRF for linking and rechecks revocation on callback', async () => {
  expect((await auth('/sso/start', { workspace_id: workspace, link: true })).statusCode).toBe(401);

  expect(
    (await auth('/sso/start', { workspace_id: workspace, link: true }, { ...owner, csrf: 'wrong' }))
      .statusCode,
  ).toBe(403);

  const attempt = await start(true);

  await auth('/logout', {}, owner);
  expect((await finish(attempt)).headers.location).toContain('error=failed');
});

it('enforces SSO on reads, writes and stale principals while preserving local account recovery', async () => {
  expect((await api('/identity/auth-policy', { ...defaults, require_sso: true })).statusCode).toBe(
    403,
  );

  const previous = (await api('/snapshot')).json().principal;

  await connect();
  const signedIn = await signIn();

  expect(
    (await api('/identity/auth-policy', { ...defaults, require_sso: true }, signedIn)).statusCode,
  ).toBe(200);

  expect((await api('/snapshot')).statusCode).toBe(403);

  expect(
    (await api('/projects', { name: 'Blocked', slug: 'blocked', description: '' })).statusCode,
  ).toBe(403);

  await expect(transaction(db, (tx) => lockPrincipal(tx, previous))).rejects.toMatchObject({
    code: 'AUTH_POLICY_REQUIRED',
  });

  expect((await api('/snapshot', undefined, signedIn)).statusCode).toBe(200);

  expect(
    (await app.inject({ url: '/api/auth/security', headers: { cookie: owner.cookie } })).statusCode,
  ).toBe(200);

  await identityAdmin(db, ['reset-auth-policy', workspace], origin);
  expect((await api('/snapshot')).statusCode).toBe(200);
});

it('does not allow an SSO session into another workspace or to link another provider', async () => {
  await connect();
  const other = (await fixture(db)).org;
  const invitation = await identityAdmin(db, ['invite-owner', other, email], origin);

  const accepted = await auth(
    '/accept',
    { token: new URL(invitation.link!).hash.split('token=')[1] },
    owner,
  );

  owner = await session(accepted.headers['set-cookie'] as string);
  const signedIn = await signIn();

  expect((await api('/snapshot', undefined, signedIn, other)).statusCode).toBe(403);

  expect(
    (await auth('/sso/start', { workspace_id: workspace, link: true }, signedIn)).statusCode,
  ).toBe(403);
});

it('requires Keel MFA after SSO and carries the provider proof through the challenge', async () => {
  await connect();
  const secret = newTotpSecret();

  await db.query('UPDATE users SET mfa_secret=$2,mfa_enabled_at=now() WHERE id=$1', [
    owner.userId,
    mfaVault().encrypt(owner.userId, 'totp', secret),
  ]);

  const response = await finish(await start());

  const challenge = new URLSearchParams(new URL(response.headers.location!).hash.split('?')[1]).get(
    'challenge',
  );

  expect(challenge).toBeTruthy();

  const signInAudit = () =>
    db.query(
      `
        SELECT
          *
        FROM
          audit_events
        WHERE
          organisation_id = $1
          AND action = 'account.sso_signed_in'
      `,
      [workspace],
    );

  expect((await signInAudit()).rowCount).toBe(0);

  const result = await auth('/mfa/challenge', {
    challenge,
    code: totp(secret, Math.floor(Date.now() / 30000)),
  });

  expect(result.statusCode, result.body).toBe(200);
  expect((await signInAudit()).rows[0].details.mfa_verified).toBe(true);
  const signedIn = await session(result.headers['set-cookie'] as string);

  expect(
    (
      await api(
        '/identity/auth-policy',
        { ...defaults, require_sso: true, require_mfa: true },
        signedIn,
      )
    ).statusCode,
  ).toBe(200);

  expect((await api('/snapshot', undefined, signedIn)).statusCode).toBe(200);
});

it('enforces MFA, API-token restrictions and session age; revokes old tokens on policy change', async () => {
  expect((await api('/identity/auth-policy', { ...defaults, require_mfa: true })).statusCode).toBe(
    403,
  );

  const token = (
    await api('/identity/tokens', { name: 'Automation', permissions: ['read'], expires_in_days: 7 })
  ).json().token;

  const bearer = () =>
    app.inject({ url: '/api/v1/snapshot', headers: { authorization: `Bearer ${token}` } });

  expect((await bearer()).statusCode).toBe(200);

  expect(
    (
      await api('/identity/auth-policy', {
        ...defaults,
        allow_api_tokens: false,
        session_minutes: 15,
      })
    ).statusCode,
  ).toBe(200);

  expect((await bearer()).statusCode).toBe(401);

  expect(
    (await api('/identity/tokens', { name: 'Blocked', permissions: ['read'], expires_in_days: 7 }))
      .statusCode,
  ).toBe(403);

  await db.query(
    `
      UPDATE browser_sessions
      SET
        authenticated_at = now() - interval '16 minutes'
      WHERE
        token_hash = $1
    `,
    [sha256(owner.cookie.split('=')[1])],
  );

  expect((await api('/snapshot')).statusCode).toBe(403);
});

it('invalidates sessions and pending callbacks when the operator replaces a provider', async () => {
  await connect();
  const signedIn = await signIn();
  const pending = await start();

  await configureSso(db, workspace, provider.config, origin);
  expect((await api('/snapshot', undefined, signedIn)).statusCode).toBe(401);
  expect((await finish(pending)).headers.location).toContain('error=failed');
  expect((await finish(await start())).headers.location).toContain('error=failed');
});

it('rejects unsafe endpoint configuration and policy values', async () => {
  expect(() => validateSsoConfiguration(provider.config, 'https://keel.example')).toThrow('HTTPS');

  expect(() =>
    validateSsoConfiguration(
      { ...provider.config, issuer: 'https://user:password@example.com' },
      origin,
    ),
  ).toThrow();

  expect((await api('/identity/auth-policy', { ...defaults, session_minutes: 1 })).statusCode).toBe(
    400,
  );
});

it('rechecks membership and provider retirement before issuing an SSO session', async () => {
  await connect();
  const pending = await start();

  await db.query(
    'UPDATE memberships SET removed_at=now() WHERE organisation_id=$1 AND user_id=$2',
    [workspace, owner.userId],
  );

  expect((await finish(pending)).headers.location).toContain('error=failed');

  await db.query('UPDATE memberships SET removed_at=NULL WHERE organisation_id=$1 AND user_id=$2', [
    workspace,
    owner.userId,
  ]);

  const secret = newTotpSecret();
  const recovery = '01234567-89abcdef-01234567';

  await db.query('UPDATE users SET mfa_secret=$2,mfa_enabled_at=now() WHERE id=$1', [
    owner.userId,
    mfaVault().encrypt(owner.userId, 'totp', secret),
  ]);

  await db.query('INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)', [
    owner.userId,
    sha256(`${owner.userId}:${recovery}`),
  ]);

  const response = await finish(await start());

  const challenge = new URLSearchParams(new URL(response.headers.location!).hash.split('?')[1]).get(
    'challenge',
  );

  expect(challenge).toBeTruthy();
  await configureSso(db, workspace, provider.config, origin);
  expect((await auth('/mfa/challenge', { challenge, code: recovery })).statusCode).toBe(403);

  expect(
    (await db.query('SELECT 1 FROM mfa_recovery_codes WHERE user_id=$1', [owner.userId])).rowCount,
  ).toBe(1);
});

it('restricts policy writes to owners and enforces token policy even on a still-active token row', async () => {
  const token = (
    await api('/identity/tokens', {
      name: 'Policy test',
      permissions: ['read'],
      expires_in_days: 1,
    })
  ).json().token;

  await db.query(
    `
      INSERT INTO
        workspace_auth_policies (organisation_id, allow_api_tokens)
      VALUES
        ($1, FALSE)
    `,
    [workspace],
  );

  const bearer = await app.inject({
    url: '/api/v1/snapshot',
    headers: { authorization: `Bearer ${token}` },
  });

  expect(bearer.statusCode).toBe(403);
  expect(bearer.json().error.code).toBe('AUTH_POLICY_REQUIRED');

  await db.query("UPDATE memberships SET role='admin' WHERE organisation_id=$1 AND user_id=$2", [
    workspace,
    owner.userId,
  ]);

  expect((await api('/identity/auth-policy', defaults)).statusCode).toBe(403);
  expect((await api('/identity/auth-policy')).statusCode).toBe(200);

  await db.query('UPDATE workspace_auth_policies SET require_mfa=true WHERE organisation_id=$1', [
    workspace,
  ]);

  expect((await api('/snapshot')).statusCode).toBe(403);

  expect(
    (await app.inject({ url: '/api/auth/security', headers: { cookie: owner.cookie } })).statusCode,
  ).toBe(200);
});

it('does not extend workspace session age by accepting an invitation and rotating the cookie', async () => {
  expect(
    (await api('/identity/auth-policy', { ...defaults, session_minutes: 15 })).statusCode,
  ).toBe(200);

  await db.query(
    `
      UPDATE browser_sessions
      SET
        authenticated_at = now() - interval '16 minutes'
      WHERE
        user_id = $1
    `,
    [owner.userId],
  );

  const invite = await identityAdmin(
    db,
    ['create-workspace', 'Additional workspace', email],
    origin,
  );

  const response = await auth(
    '/accept',
    { token: new URL(invite.link!).hash.split('token=')[1] },
    owner,
  );

  expect(response.statusCode, response.body).toBe(200);
  const rotated = await session(response.headers['set-cookie'] as string);

  expect((await api('/snapshot', undefined, rotated)).statusCode).toBe(403);
  expect((await api('/snapshot', undefined, rotated, invite.workspace_id)).statusCode).toBe(200);
});
