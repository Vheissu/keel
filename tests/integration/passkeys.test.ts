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
import { passkeyAuthenticator } from '../passkey-authenticator.js';
import { quarantine } from '../../apps/operations/src/recovery.js';
import { fixture, testDatabaseUrl } from '../fixtures.js';
import { mfaVault } from '../../apps/api/src/account-security.js';
import { totp, newTotpSecret } from '../../apps/api/src/totp.js';

const schema = `passkeys_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const origin = 'http://localhost:5174';
const password = 'a long and memorable password';
let app: FastifyInstance;
let root: string;
let workspace: string;
let email: string;
let ip = 0;

type Session = { cookie: string; csrf: string; userId: string };

let owner: Session;

beforeAll(async () => {
  process.env.KEEL_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-passkeys-'));

  app = await createApp(
    new ControlPlane(db, new LocalArtifactStore(root)),
    false,
    undefined,
    undefined,
    origin,
  );
});

beforeEach(async () => {
  workspace = (await fixture(db)).org;
  email = `owner-${randomUUID()}@example.com`;
  const provisioned = await identityAdmin(db, ['invite-owner', workspace, email], origin);
  const token = new URL(provisioned.link!).hash.split('token=')[1];
  const response = await auth('/accept', { token, name: 'Owner', password });

  expect(response.statusCode, response.body).toBe(200);
  owner = await session(response.headers['set-cookie'] as string);
});

afterAll(async () => {
  await app?.close();

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

async function enroll(key = passkeyAuthenticator()) {
  const start = await auth(
    '/passkeys/enroll',
    { name: 'Laptop', current_password: password },
    owner,
  );

  expect(start.statusCode, start.body).toBe(200);
  const { options, attempt } = start.json();

  const confirm = await auth(
    '/passkeys/confirm',
    { attempt, response: key.registration(options.challenge, origin) },
    owner,
  );

  expect(confirm.statusCode, confirm.body).toBe(200);

  return key;
}

async function options() {
  const start = await auth('/passkeys/options', {});

  expect(start.statusCode).toBe(200);

  return {
    challenge: start.json().options.challenge as string,
    cookie: (start.headers['set-cookie'] as string).split(';')[0],
  };
}

function login(response: object, cookie: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/passkeys/login',
    payload: { response },
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: { origin, cookie },
  });
}

it('enrolls and signs in with a real signature, consumes challenges and updates counters', async () => {
  const key = await enroll();
  const attempt = await options();
  const assertion = key.assertion(attempt.challenge, origin, owner.userId);
  const result = await login(assertion, attempt.cookie);

  expect(result.statusCode, result.body).toBe(200);
  const cookies = result.headers['set-cookie'] as string[];
  const signedIn = await session(cookies.find((value) => value.startsWith('keel_session='))!);

  expect((await api('/snapshot', undefined, signedIn)).statusCode).toBe(200);
  expect((await login(assertion, attempt.cookie)).statusCode).toBe(400);
  const row = (await db.query('SELECT * FROM passkeys WHERE id=$1', [key.id])).rows[0];

  expect(row.counter).toBe('1');
  expect(row.last_used_at).toBeTruthy();
  expect(row.public_key).toBeInstanceOf(Buffer);
  const stale = await options();

  expect(
    (await login(key.assertion(stale.challenge, origin, owner.userId, 1), stale.cookie)).statusCode,
  ).toBe(400);
});

it.each(['origin', 'rp', 'challenge', 'signature', 'verification', 'presence', 'user', 'cookie'])(
  'rejects an invalid %s without issuing a session',
  async (fault) => {
    const key = await enroll();
    const attempt = await options();

    const flags = fault === 'verification' ? 1 : 5;

    const assertion = key.assertion(
      fault === 'challenge' ? 'wrong' : attempt.challenge,
      fault === 'origin' ? 'https://attacker.example' : origin,
      fault === 'user' ? randomUUID() : owner.userId,
      1,
      fault === 'presence' ? 4 : flags,
      fault === 'rp' ? 'other.example' : new URL(origin).hostname,
    );

    if (fault === 'signature') {
      assertion.response.signature = Buffer.alloc(64).toString('base64url');
    }

    const result = await login(assertion, fault === 'cookie' ? '' : attempt.cookie);

    expect(result.statusCode, result.body).toBe(400);
    expect(result.json().error.code).toBe('PASSKEY_INVALID');
    expect(String(result.headers['set-cookie'] || '')).not.toContain('keel_session=');
  },
);

it('requires origin, CSRF, current password and a live enrollment session', async () => {
  expect(
    (await auth('/passkeys/enroll', { name: 'Key', current_password: 'incorrect' }, owner))
      .statusCode,
  ).toBe(403);

  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/passkeys/options',
        payload: {},
        headers: { origin: 'https://attacker.example' },
      })
    ).statusCode,
  ).toBe(403);

  expect(
    (
      await auth(
        '/passkeys/enroll',
        { name: 'Key', current_password: password },
        { ...owner, csrf: 'wrong' },
      )
    ).statusCode,
  ).toBe(403);

  const start = await auth('/passkeys/enroll', { name: 'Key', current_password: password }, owner);
  const response = passkeyAuthenticator().registration(start.json().options.challenge, origin);

  await auth('/logout', {}, owner);

  expect(
    (await auth('/passkeys/confirm', { attempt: start.json().attempt, response }, owner))
      .statusCode,
  ).toBe(401);
});

it('binds enrollment to its session and rejects duplicate registration and missing verification', async () => {
  const key = await enroll();

  const start = await auth(
    '/passkeys/enroll',
    { name: 'Again', current_password: password },
    owner,
  );

  const response = key.registration(start.json().options.challenge, origin);

  const second = await session(
    (await auth('/login', { email, password })).headers['set-cookie'] as string,
  );

  expect(
    (await auth('/passkeys/confirm', { attempt: start.json().attempt, response }, second))
      .statusCode,
  ).toBe(400);

  expect(
    (await auth('/passkeys/confirm', { attempt: start.json().attempt, response }, owner))
      .statusCode,
  ).toBe(409);

  expect(
    (await auth('/passkeys/confirm', { attempt: start.json().attempt, response }, owner))
      .statusCode,
  ).toBe(400);

  const next = await auth('/passkeys/enroll', { name: 'No UV', current_password: password }, owner);

  expect(
    (
      await auth(
        '/passkeys/confirm',
        {
          attempt: next.json().attempt,
          response: passkeyAuthenticator().registration(
            next.json().options.challenge,
            origin,
            0x41,
          ),
        },
        owner,
      )
    ).statusCode,
  ).toBe(400);
});

it('rejects expired login and enrollment challenges', async () => {
  const key = await enroll();
  const attempt = await options();

  await db.query("UPDATE passkey_attempts SET expires_at=now()-interval '1 second'");

  expect(
    (await login(key.assertion(attempt.challenge, origin, owner.userId), attempt.cookie))
      .statusCode,
  ).toBe(400);

  const start = await auth(
    '/passkeys/enroll',
    { name: 'Expired', current_password: password },
    owner,
  );

  await db.query("UPDATE passkey_attempts SET expires_at=now()-interval '1 second'");

  expect(
    (
      await auth(
        '/passkeys/confirm',
        {
          attempt: start.json().attempt,
          response: key.registration(start.json().options.challenge, origin),
        },
        owner,
      )
    ).statusCode,
  ).toBe(400);
});

it('allows only one concurrent use of a login challenge', async () => {
  const key = await enroll();
  const attempt = await options();
  const response = key.assertion(attempt.challenge, origin, owner.userId);

  const results = await Promise.all([
    login(response, attempt.cookie),
    login(response, attempt.cookie),
  ]);

  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);
});

it('keeps MFA mandatory after passkey authentication and cancels challenges on removal', async () => {
  const key = await enroll();
  const secret = newTotpSecret();

  await db.query('UPDATE users SET mfa_secret=$2 WHERE id=$1', [
    owner.userId,
    mfaVault().encrypt(owner.userId, 'totp', secret),
  ]);

  await db.query('UPDATE browser_sessions SET mfa_verified=true WHERE user_id=$1', [owner.userId]);
  const attempt = await options();

  const result = await login(
    key.assertion(attempt.challenge, origin, owner.userId),
    attempt.cookie,
  );

  expect(result.json().mfa_required).toBe(true);
  expect(String(result.headers['set-cookie'])).toContain('keel_session=;');

  const complete = await auth('/mfa/challenge', {
    challenge: result.json().challenge,
    code: totp(secret),
  });

  expect(complete.statusCode, complete.body).toBe(200);
  const next = await options();
  const pending = await login(key.assertion(next.challenge, origin, owner.userId, 2), next.cookie);

  expect(
    (await auth('/passkeys/remove', { id: key.id, current_password: password }, owner)).statusCode,
  ).toBe(200);

  expect(
    (await auth('/mfa/challenge', { challenge: pending.json().challenge, code: totp(secret) }))
      .statusCode,
  ).toBe(403);

  expect(
    (await db.query('SELECT 1 FROM mfa_challenges WHERE user_id=$1', [owner.userId])).rowCount,
  ).toBe(0);
});

it('honors workspace SSO and MFA policies after passkey sign-in', async () => {
  const key = await enroll();
  const attempt = await options();

  const result = await login(
    key.assertion(attempt.challenge, origin, owner.userId),
    attempt.cookie,
  );

  const signedIn = await session(
    (result.headers['set-cookie'] as string[]).find((value) => value.startsWith('keel_session='))!,
  );

  await db.query(
    'INSERT INTO workspace_auth_policies(organisation_id,require_sso) VALUES($1,true)',
    [workspace],
  );

  expect((await api('/snapshot', undefined, signedIn)).statusCode).toBe(403);

  await db.query(
    'UPDATE workspace_auth_policies SET require_sso=false,require_mfa=true WHERE organisation_id=$1',
    [workspace],
  );

  expect((await api('/snapshot', undefined, signedIn)).statusCode).toBe(403);
});

it('removal revokes sessions and tokens while preserving other passkeys', async () => {
  const key = await enroll();
  const other = await enroll();

  const token = await api('/identity/tokens', {
    name: 'automation',
    permissions: ['read'],
    expires_in_days: 1,
  });

  expect(token.statusCode, token.body).toBe(200);
  const removed = await auth('/passkeys/remove', { id: key.id, current_password: password }, owner);

  expect(removed.statusCode).toBe(200);
  expect((await api('/snapshot')).statusCode).toBe(401);

  expect((await db.query('SELECT id FROM passkeys WHERE user_id=$1', [owner.userId])).rows).toEqual(
    [{ id: other.id }],
  );

  expect(
    (
      await db.query('SELECT id FROM api_tokens WHERE user_id=$1 AND revoked_at IS NULL', [
        owner.userId,
      ])
    ).rowCount,
  ).toBe(0);
});

it('password recovery clears passkeys and restore quarantines credentials and attempts', async () => {
  await enroll();
  const reset = await identityAdmin(db, ['reset-password', email], origin);
  const token = new URL(reset.link!).hash.split('token=')[1];

  expect(
    (await auth('/reset-password', { token, password: 'another long and memorable password' }))
      .statusCode,
  ).toBe(200);

  expect((await db.query('SELECT 1 FROM passkeys WHERE user_id=$1', [owner.userId])).rowCount).toBe(
    0,
  );

  const start = await options();

  await quarantine(db);

  expect(
    (
      await db.query('SELECT 1 FROM passkey_attempts WHERE token_hash=$1', [
        sha256(start.cookie.split('=')[1]),
      ])
    ).rowCount,
  ).toBe(0);
});

it('supports zero-counter synced passkeys without accepting changed backup eligibility', async () => {
  const key = passkeyAuthenticator();

  const start = await auth(
    '/passkeys/enroll',
    { name: 'Synced', current_password: password },
    owner,
  );

  const confirmed = await auth(
    '/passkeys/confirm',
    {
      attempt: start.json().attempt,
      response: key.registration(start.json().options.challenge, origin, 0x5d),
    },
    owner,
  );

  expect(confirmed.statusCode, confirmed.body).toBe(200);

  for (let index = 0; index < 2; index++) {
    const attempt = await options();

    expect(
      (await login(key.assertion(attempt.challenge, origin, owner.userId, 0, 0x1d), attempt.cookie))
        .statusCode,
    ).toBe(200);
  }

  const changed = await options();

  expect(
    (await login(key.assertion(changed.challenge, origin, owner.userId, 1, 5), changed.cookie))
      .statusCode,
  ).toBe(400);
});

it('bounds enrollment count and applies the shared account verification budget', async () => {
  const key = await enroll();

  for (let index = 0; index < 9; index++) {
    await db.query(
      `INSERT INTO passkeys(id,user_id,name,public_key,counter,transports,backed_up,device_type)
      SELECT $2,user_id,name,public_key,counter,transports,backed_up,device_type FROM passkeys WHERE id=$1`,
      [key.id, Buffer.from(randomUUID()).toString('base64url')],
    );
  }

  expect(
    (await auth('/passkeys/enroll', { name: 'Eleventh', current_password: password }, owner))
      .statusCode,
  ).toBe(409);

  await db.query('INSERT INTO login_attempts(subject_hash,attempts) VALUES($1,8)', [
    sha256(`passkey:${owner.userId}`),
  ]);

  const attempt = await options();

  expect(
    (await login(key.assertion(attempt.challenge, origin, owner.userId), attempt.cookie))
      .statusCode,
  ).toBe(429);
});

it('rejects cross-account removal and malformed payloads', async () => {
  const key = await enroll();
  const otherEmail = `other-${randomUUID()}@example.com`;
  const invited = await identityAdmin(db, ['invite-owner', workspace, otherEmail], origin);

  const accepted = await auth('/accept', {
    token: new URL(invited.link!).hash.split('token=')[1],
    name: 'Other',
    password,
  });

  const other = await session(accepted.headers['set-cookie'] as string);

  expect(
    (await auth('/passkeys/remove', { id: key.id, current_password: password }, other)).statusCode,
  ).toBe(404);

  expect((await auth('/passkeys/login', { response: { id: key.id } })).statusCode).toBe(400);

  const oversized = await app.inject({
    method: 'POST',
    url: '/api/auth/passkeys/login',
    payload: { response: 'x'.repeat(70000) },
    headers: { origin },
  });

  expect(oversized.statusCode).toBe(413);
});

it('keeps ordinary password changes compatible with existing passkeys', async () => {
  const key = await enroll();

  const pending = await auth(
    '/passkeys/enroll',
    { name: 'Pending', current_password: password },
    owner,
  );

  expect(pending.statusCode).toBe(200);

  expect(
    (
      await auth(
        '/password',
        { current_password: password, password: 'another long password phrase' },
        owner,
      )
    ).statusCode,
  ).toBe(200);

  expect(
    (await db.query('SELECT 1 FROM passkey_attempts WHERE user_id=$1', [owner.userId])).rowCount,
  ).toBe(0);

  const attempt = await options();

  expect(
    (await login(key.assertion(attempt.challenge, origin, owner.userId), attempt.cookie))
      .statusCode,
  ).toBe(200);
});

it('uses secure, browser-bound cookies and rejects IP relying parties', async () => {
  const secureOrigin = 'https://keel.example';

  const secure = await createApp(
    new ControlPlane(db, new LocalArtifactStore(root)),
    false,
    undefined,
    undefined,
    secureOrigin,
  );

  const ipOrigin = 'http://127.0.0.1:5174';

  const byIp = await createApp(
    new ControlPlane(db, new LocalArtifactStore(root)),
    false,
    undefined,
    undefined,
    ipOrigin,
  );

  try {
    const start = await secure.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      payload: {},
      headers: { origin: secureOrigin },
    });

    expect(start.statusCode).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');

    expect(start.headers['set-cookie']).toMatch(
      /^__Host-keel_passkey=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=300; Secure$/,
    );

    expect(start.json().options.rpId).toBe('keel.example');

    const unsupported = await byIp.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      payload: {},
      headers: { origin: ipOrigin },
    });

    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe('PASSKEY_UNAVAILABLE');
  } finally {
    await secure.close();
    await byIp.close();
  }
});

it('rejects a credential ID that does not match the attested key', async () => {
  const key = passkeyAuthenticator();

  const start = await auth(
    '/passkeys/enroll',
    { name: 'Mismatch', current_password: password },
    owner,
  );

  const response = key.registration(start.json().options.challenge, origin);

  response.id = response.rawId = Buffer.from(randomUUID()).toString('base64url');

  const result = await auth(
    '/passkeys/confirm',
    { attempt: start.json().attempt, response },
    owner,
  );

  expect(result.statusCode).toBe(400);

  expect((await db.query('SELECT 1 FROM passkeys WHERE user_id=$1', [owner.userId])).rowCount).toBe(
    0,
  );
});
