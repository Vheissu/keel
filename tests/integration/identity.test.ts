import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { mfaVault } from '../../apps/api/src/account-security.js';
import { totp } from '../../apps/api/src/totp.js';
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
import { fixture, testDatabaseUrl, deploymentProcess } from '../fixtures.js';

const schema = `identity_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const origin = 'https://keel.example';
const password = 'a long and memorable password';
let app: FastifyInstance;
let root: string;
let control: ControlPlane;
let f: Awaited<ReturnType<typeof fixture>>;

type Session = { cookie: string; csrf: string; userId: string; workspace: string };

let owner: Session;
let ip = 0;

beforeAll(async () => {
  process.env.KEEL_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-identity-'));

  control = new ControlPlane(
    db,
    new LocalArtifactStore(root),
    new CredentialVault(process.env.KEEL_CREDENTIAL_KEY, 'deployment-secrets'),
  );

  app = await createApp(control, false, undefined, undefined, origin);
});

beforeEach(async () => {
  f = await fixture(db);

  const provisioned = await identityAdmin(
    db,
    ['invite-owner', f.org, `owner-${randomUUID()}@example.com`],
    origin,
  );

  const token = new URL(provisioned.link).hash.split('token=')[1];
  const response = await auth('/accept', { token, name: 'Owner', password });

  expect(response.statusCode, response.body).toBe(200);
  owner = await session(response.headers['set-cookie'] as string, f.org);
});

afterAll(async () => {
  await app.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

function auth(
  path: string,
  payload: object,
  signedIn?: Session,
  extra: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/auth${path}`,
    payload,
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: {
      origin,
      ...(signedIn ? { cookie: signedIn.cookie, 'x-csrf-token': signedIn.csrf } : {}),
      ...extra,
    },
  });
}

async function session(cookie: string, workspace: string): Promise<Session> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/session',
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: { cookie: cookie.split(';')[0] },
  });

  expect(response.statusCode).toBe(200);

  return {
    cookie: cookie.split(';')[0],
    csrf: response.json().csrf,
    userId: response.json().user.id,
    workspace,
  };
}

function api(path: string, payload?: object, signedIn = owner, key = randomUUID()) {
  return app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url: `/api/v1${path}`,
    payload,
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: {
      origin,
      cookie: signedIn.cookie,
      'x-csrf-token': signedIn.csrf,
      'x-workspace-id': signedIn.workspace,
      'idempotency-key': key,
    },
  });
}

async function invite(role = 'operator', email = `${randomUUID()}@example.com`) {
  const response = await api('/identity/invitations', { email, role });

  expect(response.statusCode, response.body).toBe(200);

  return { ...response.json(), token: new URL(response.json().link).hash.split('token=')[1] };
}

async function member(role = 'operator') {
  const invitation = await invite(role);
  const response = await auth('/accept', { token: invitation.token, name: 'Member', password });

  expect(response.statusCode, response.body).toBe(200);

  return session(response.headers['set-cookie'] as string, owner.workspace);
}

async function token(signedIn = owner, permissions = ['read', 'write']) {
  const response = await api(
    '/identity/tokens',
    { name: 'CI', permissions, expires_in_days: 30 },
    signedIn,
  );

  expect(response.statusCode, response.body).toBe(200);

  return response.json();
}

function bearer(value: string, path = '/snapshot', payload?: object, workspace?: string) {
  return app.inject({
    method: payload ? 'POST' : 'GET',
    url: `/api/v1${path}`,
    payload,
    remoteAddress: `192.0.2.${(++ip % 250) + 1}`,
    headers: {
      authorization: `Bearer ${value}`,
      'idempotency-key': randomUUID(),
      ...(workspace ? { 'x-workspace-id': workspace } : {}),
    },
  });
}

it('provisions invitation-only accounts with secure cookies and no public signup', async () => {
  expect(owner.cookie).toMatch(/^__Host-keel_session=/);
  const user = (await db.query('SELECT * FROM users WHERE id=$1', [owner.userId])).rows[0];

  expect(user.password_hash).toMatch(/^scrypt-v1\$/);
  expect(user.password_hash).not.toContain(password);
  const login = await auth('/login', { email: user.email.toUpperCase(), password });

  expect(login.statusCode).toBe(200);
  expect(login.headers['set-cookie']).toContain('HttpOnly; SameSite=Lax; Max-Age=43200; Secure');
  expect(login.headers['cache-control']).toBe('no-store');
  expect((await auth('/signup', { email: 'nobody@example.com', password })).statusCode).toBe(404);
  expect((await bearer(f.operator.token)).statusCode).toBe(401);
  const wrong = await auth('/login', { email: user.email, password: 'wrong' });
  const unknown = await auth('/login', { email: 'absent@example.com', password: 'wrong' });

  expect(wrong.json().error.message).toBe(unknown.json().error.message);
  expect(wrong.statusCode).toBe(401);
});

it('rejects cross-origin and missing-CSRF writes while enforcing workspace membership', async () => {
  expect(
    (
      await auth('/login', { email: 'x@example.com', password }, undefined, {
        origin: 'https://evil.example',
      })
    ).statusCode,
  ).toBe(403);

  expect(
    (await api('/projects', { name: 'Denied', slug: 'denied' }, { ...owner, csrf: '' })).statusCode,
  ).toBe(403);

  expect(
    (await api('/snapshot', undefined, { ...owner, workspace: randomUUID() })).statusCode,
  ).toBe(403);

  expect((await api('/projects', { name: 'Allowed', slug: 'allowed' })).statusCode).toBe(200);

  await db.query(
    "UPDATE browser_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [owner.userId],
  );

  expect((await api('/snapshot')).statusCode).toBe(401);
});

it('accepts each invitation once and rejects revoked, expired and mismatched existing accounts', async () => {
  const first = await invite();
  const accepted = await auth('/accept', { token: first.token, name: 'Member', password });

  expect(accepted.statusCode).toBe(200);

  expect((await auth('/accept', { token: first.token, name: 'Member', password })).statusCode).toBe(
    400,
  );

  const revoked = await invite();

  await api(`/identity/invitations/${revoked.id}/revoke`, {});

  expect(
    (await auth('/accept', { token: revoked.token, name: 'Member', password })).statusCode,
  ).toBe(400);

  const expired = await invite();

  await db.query('UPDATE workspace_invitations SET expires_at=now() WHERE id=$1', [expired.id]);
  expect((await auth('/invitation', { token: expired.token })).statusCode).toBe(400);

  const elsewhere = await identityAdmin(
    db,
    ['create-workspace', 'Other workspace', first.email],
    origin,
  );

  const token = new URL(elsewhere.link).hash.split('token=')[1];

  expect((await auth('/accept', { token }, owner)).statusCode).toBe(403);
  expect((await auth('/accept', { token, name: 'Hijacker', password })).statusCode).toBe(403);
  const matching = await session(accepted.headers['set-cookie'] as string, owner.workspace);

  expect((await auth('/accept', { token }, matching)).statusCode).toBe(200);
});

it('keeps token grants within current membership and revokes all workspace tokens on removal', async () => {
  const operator = await member();

  expect(
    (
      await api(
        '/identity/tokens',
        { name: 'Too much', permissions: ['read', 'approve'], expires_in_days: 30 },
        operator,
      )
    ).statusCode,
  ).toBe(403);

  const issued = await token(operator);

  expect(
    (await bearer(issued.token, '/projects', { name: 'Before', slug: 'before' })).statusCode,
  ).toBe(200);

  expect((await bearer(issued.token, '/snapshot', undefined, randomUUID())).statusCode).toBe(403);

  expect((await api(`/identity/members/${operator.userId}`, { role: 'reader' })).statusCode).toBe(
    200,
  );

  expect(
    (await bearer(issued.token, '/projects', { name: 'After', slug: 'after' })).statusCode,
  ).toBe(403);

  expect((await bearer(issued.token)).json().principal.permissions).toEqual(['read']);
  expect((await api(`/identity/members/${operator.userId}`, { role: null })).statusCode).toBe(200);
  expect((await bearer(issued.token)).statusCode).toBe(401);
  expect((await api('/snapshot', undefined, operator)).statusCode).toBe(403);

  expect(
    (
      await db.query(
        `
          SELECT
            1
          FROM
            actors
          WHERE
            id = (
              SELECT
                actor_id
              FROM
                memberships
              WHERE
                user_id = $1
                AND organisation_id = $2
            )
        `,
        [operator.userId, owner.workspace],
      )
    ).rowCount,
  ).toBe(1);
});

it('protects owners, administrators and member lists from lower roles', async () => {
  const administrator = await member('admin');

  expect(
    (await api(`/identity/members/${owner.userId}`, { role: null }, administrator)).statusCode,
  ).toBe(403);

  expect(
    (
      await api(
        '/identity/invitations',
        { email: 'elevate@example.com', role: 'owner' },
        administrator,
      )
    ).statusCode,
  ).toBe(403);

  const reader = await member('reader');

  expect((await api('/identity/members', undefined, reader)).statusCode).toBe(403);

  expect(
    (await api('/identity/invitations', { email: 'new@example.com', role: 'reader' }, reader))
      .statusCode,
  ).toBe(403);

  const issued = await token();

  expect((await bearer(issued.token, '/identity/tokens')).statusCode).toBe(403);
  expect((await api(`/identity/members/${owner.userId}`, { role: 'reader' })).statusCode).toBe(409);
  expect((await api(`/identity/members/${owner.userId}`, { role: null })).statusCode).toBe(409);
});

it('serializes concurrent owner changes so a workspace always retains an owner', async () => {
  const second = await member('owner');

  const responses = await Promise.all([
    api(`/identity/members/${owner.userId}`, { role: 'reader' }),
    api(`/identity/members/${second.userId}`, { role: 'reader' }, second),
  ]);

  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);

  expect(
    Number(
      (
        await db.query(
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
          [owner.workspace],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
});

it('reveals tokens and invitations once without retaining secrets in idempotency results', async () => {
  const key = randomUUID();
  const payload = { name: 'Once', permissions: ['read'], expires_in_days: 1 };
  const first = await api('/identity/tokens', payload, owner, key);
  const replay = await api('/identity/tokens', payload, owner, key);

  expect(first.json().token).toBeTruthy();
  expect(replay.json().token).toBeUndefined();
  expect(replay.json().id).toBe(first.json().id);

  const stored = (await db.query('SELECT response FROM idempotency_keys WHERE key=$1', [key]))
    .rows[0].response;

  expect(JSON.stringify(stored)).not.toContain(first.json().token);
  const inviteKey = randomUUID();
  const input = { email: 'once@example.com', role: 'reader' };

  expect((await api('/identity/invitations', input, owner, inviteKey)).json().link).toBeTruthy();
  expect((await api('/identity/invitations', input, owner, inviteKey)).json().link).toBeUndefined();
});

it('rotates atomically, enforces expiry and permits owners to revoke another member token', async () => {
  const other = await member();
  const initial = await token(other);

  const rotation = await api(
    `/identity/tokens/${initial.id}/rotate`,
    { name: 'Replacement', permissions: ['read'], expires_in_days: 1 },
    other,
  );

  expect(rotation.statusCode).toBe(200);
  expect((await bearer(initial.token)).statusCode).toBe(401);
  expect((await bearer(rotation.json().token)).statusCode).toBe(200);
  expect((await api(`/identity/tokens/${rotation.json().id}/revoke`, {})).statusCode).toBe(200);
  expect((await bearer(rotation.json().token)).statusCode).toBe(401);
  const expiry = await token();

  await db.query('UPDATE api_tokens SET expires_at=now() WHERE id=$1', [expiry.id]);
  expect((await bearer(expiry.token)).statusCode).toBe(401);

  expect(
    (await api('/identity/tokens', { name: 'Forever', permissions: ['read'], expires_in_days: 91 }))
      .statusCode,
  ).toBe(400);
});

it('password recovery revokes sessions and tokens across workspaces and cannot be replayed', async () => {
  const issued = await token();

  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  const reset = await identityAdmin(db, ['reset-password', email], origin);
  const tokenValue = new URL(reset.link).hash.split('token=')[1];
  const replacement = 'another memorable long password';
  const result = await auth('/reset-password', { token: tokenValue, password: replacement });

  expect(result.statusCode, result.body).toBe(200);
  expect((await api('/snapshot')).statusCode).toBe(401);
  expect((await bearer(issued.token)).statusCode).toBe(401);

  expect(
    (await auth('/reset-password', { token: tokenValue, password: replacement })).statusCode,
  ).toBe(400);

  expect((await auth('/login', { email, password })).statusCode).toBe(401);
  expect((await auth('/login', { email, password: replacement })).statusCode).toBe(200);

  expect(
    (
      await db.query(
        `
          SELECT
            1
          FROM
            audit_events
          WHERE
            organisation_id = $1
            AND action = 'account.password_changed'
        `,
        [owner.workspace],
      )
    ).rowCount,
  ).toBe(1);
});

it('checks current credentials again inside writes after a membership change', async () => {
  const operator = await member();
  const issued = await token(operator);
  const principal = await control.authenticate(issued.token);

  await api(`/identity/members/${operator.userId}`, { role: 'reader' });

  await expect(
    control.mutate(principal, randomUUID(), sha256('stale-write'), (tx) =>
      control.project(tx, principal, { name: 'Stale', slug: 'stale', description: '' }),
    ),
  ).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });

  expect(
    (
      await db.query("SELECT 1 FROM projects WHERE organisation_id=$1 AND slug='stale'", [
        owner.workspace,
      ])
    ).rowCount,
  ).toBe(0);
});

it('prevents administrators from replacing an outstanding owner invitation', async () => {
  const administrator = await member('admin');
  const invitation = await invite('owner');

  const replacement = await api(
    '/identity/invitations',
    { email: invitation.email, role: 'reader' },
    administrator,
  );

  expect(replacement.statusCode).toBe(403);
  expect((await auth('/invitation', { token: invitation.token })).statusCode).toBe(200);
});

it('shares account login budgets across client addresses without revealing account existence', async () => {
  const email = `unknown-${randomUUID()}@example.com`;

  await db.query('INSERT INTO login_attempts(subject_hash,attempts) VALUES($1,8)', [sha256(email)]);
  const response = await auth('/login', { email, password: 'wrong' });

  expect(response.statusCode).toBe(429);
  expect(response.json().error.code).toBe('LOGIN_RATE_LIMIT');

  await db.query(
    `
      UPDATE login_attempts
      SET
        window_start = now() - interval '2 minutes'
      WHERE
        subject_hash = $1
    `,
    [sha256(email)],
  );

  expect((await auth('/login', { email, password: 'wrong' })).statusCode).toBe(401);
});

it('retains another workspace membership when access is removed and reuses the original actor on rejoining', async () => {
  const invited = await invite();
  const accepted = await auth('/accept', { token: invited.token, name: 'Member', password });
  const signedIn = await session(accepted.headers['set-cookie'] as string, owner.workspace);
  const actor = (await api('/snapshot', undefined, signedIn)).json().principal.actor_id;

  const other = await identityAdmin(
    db,
    ['create-workspace', 'Independent workspace', invited.email],
    origin,
  );

  const joined = await auth(
    '/accept',
    { token: new URL(other.link).hash.split('token=')[1] },
    signedIn,
  );

  const refreshed = await session(joined.headers['set-cookie'] as string, other.workspace_id);

  await api(`/identity/members/${signedIn.userId}`, { role: null });
  expect((await api('/snapshot', undefined, refreshed)).statusCode).toBe(200);
  const again = await invite('operator', invited.email);
  const rejoined = await auth('/accept', { token: again.token }, refreshed);

  expect(rejoined.statusCode).toBe(200);
  const finalSession = await session(rejoined.headers['set-cookie'] as string, owner.workspace);

  expect((await api('/snapshot', undefined, finalSession)).json().principal.actor_id).toBe(actor);
});

it('password reset waits for an in-flight credential issue and revokes the newly issued token', async () => {
  const principal = (await api('/snapshot')).json().principal;

  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  const reset = await identityAdmin(db, ['reset-password', email], origin);
  const resetToken = new URL(reset.link).hash.split('token=')[1];
  let release!: () => void;
  let entered!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const write = control.mutate(principal, randomUUID(), sha256('concurrent-token'), async (tx) => {
    entered();
    await gate;

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
            ARRAY['read'],
            'Racing token',
            now() + interval '1 day'
          )
      `,
      [
        randomUUID(),
        owner.workspace,
        principal.actor_id,
        owner.userId,
        sha256('racing-token-value'),
      ],
    );

    return { created: true };
  });

  await started;

  const resetRequest = auth('/reset-password', {
    token: resetToken,
    password: 'a replacement memorable password',
  }).then((response) => response);

  // Wait until hashing has finished and the reset is waiting on the user's shared lock.
  try {
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query(
                `
                  SELECT
                    count(*)
                  FROM
                    pg_stat_activity
                  WHERE
                    wait_event_type = 'Lock'
                    AND query LIKE 'SELECT id FROM users WHERE id=%'
                    AND pid <> pg_backend_pid()
                `,
              )
            ).rows[0].count,
          ),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
  } finally {
    release();
  }

  await write;
  expect((await resetRequest).statusCode).toBe(200);
  expect((await bearer('racing-token-value')).statusCode).toBe(401);
});

async function security(signedIn = owner) {
  return app.inject({
    method: 'GET',
    url: '/api/auth/security',
    headers: { cookie: signedIn.cookie },
  });
}

async function enroll(signedIn = owner) {
  const setup = await auth('/mfa/enroll', { current_password: password }, signedIn);

  expect(setup.statusCode, setup.body).toBe(200);

  const stored = (
    await db.query('SELECT secret FROM mfa_enrollments WHERE user_id=$1', [signedIn.userId])
  ).rows[0].secret;

  const secret = mfaVault().decrypt<string>(signedIn.userId, 'totp', stored);

  expect(JSON.stringify(stored)).not.toContain(setup.json().secret);

  const result = await auth(
    '/mfa/confirm',
    { code: totp(secret, Math.floor(Date.now() / 30000) - 1) },
    signedIn,
  );

  expect(result.statusCode, result.body).toBe(200);

  const oldCookie = signedIn.cookie;

  Object.assign(
    signedIn,
    await session(result.headers['set-cookie'] as string, signedIn.workspace),
  );

  expect(signedIn.cookie).not.toBe(oldCookie);
  expect(result.json().csrf).toBe(signedIn.csrf);

  expect(
    (
      await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: oldCookie } })
    ).json().user,
  ).toBeNull();

  return { secret, codes: result.json().recovery_codes as string[] };
}

async function challenge(signedIn = owner) {
  const email = (await db.query('SELECT email FROM users WHERE id=$1', [signedIn.userId])).rows[0]
    .email;

  const response = await auth('/login', { email, password });

  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.json().mfa_required).toBe(true);

  return response.json().challenge as string;
}

it('enables encrypted MFA, revokes older credentials, and consumes login codes exactly once', async () => {
  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  const previous = await auth('/login', { email, password });
  const old = await session(previous.headers['set-cookie'] as string, f.org);
  const managed = await token();
  const { secret, codes } = await enroll();

  expect(codes).toHaveLength(10);
  expect(new Set(codes).size).toBe(10);
  expect((await api('/snapshot', undefined, old)).statusCode).toBe(401);
  await expect(control.authenticate(managed.token)).rejects.toThrow();

  expect((await security()).json()).toMatchObject({
    mfa_enabled: true,
    recovery_codes_remaining: 10,
  });

  const id = await challenge();
  const req = { challenge: id, code: totp(secret) };
  const responses = await Promise.all([auth('/mfa/challenge', req), auth('/mfa/challenge', req)]);

  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 403]);
  const second = await challenge();

  expect((await auth('/mfa/challenge', { challenge: second, code: req.code })).statusCode).toBe(
    403,
  );

  const success = await auth('/mfa/challenge', { challenge: second, code: codes[0] });

  expect(success.statusCode, success.body).toBe(200);
  const userSession = await session(success.headers['set-cookie'] as string, f.org);

  expect((await api('/snapshot', undefined, userSession)).statusCode).toBe(200);
  expect((await security()).json().recovery_codes_remaining).toBe(9);

  const persisted = JSON.stringify(
    (await db.query('SELECT * FROM mfa_recovery_codes WHERE user_id=$1', [owner.userId])).rows,
  );

  for (const code of codes) {
    expect(persisted).not.toContain(code);
  }

  expect(
    (
      await db.query(
        "SELECT action FROM audit_events WHERE organisation_id=$1 AND action LIKE 'account.%'",
        [f.org],
      )
    ).rows.map((row) => row.action),
  ).toContain('account.recovery_code_used');
});

it('binds enrollment to the originating session, expiry, CSRF and current password', async () => {
  expect(
    (await auth('/mfa/enroll', { current_password: 'wrong password' }, owner)).statusCode,
  ).toBe(403);

  expect(
    (await auth('/mfa/enroll', { current_password: password }, owner, { 'x-csrf-token': 'wrong' }))
      .statusCode,
  ).toBe(403);

  expect(
    (
      await auth('/mfa/enroll', { current_password: password }, owner, {
        origin: 'https://other.example',
      })
    ).statusCode,
  ).toBe(403);

  const setup = await auth('/mfa/enroll', { current_password: password }, owner);

  expect(setup.statusCode).toBe(200);

  const encrypted = (
    await db.query('SELECT secret FROM mfa_enrollments WHERE user_id=$1', [owner.userId])
  ).rows[0].secret;

  const code = totp(mfaVault().decrypt<string>(owner.userId, 'totp', encrypted));

  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  const another = await auth('/login', { email, password });
  const otherSession = await session(another.headers['set-cookie'] as string, f.org);

  expect((await auth('/mfa/confirm', { code }, otherSession)).statusCode).toBe(409);

  await db.query(
    "UPDATE mfa_enrollments SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [owner.userId],
  );

  expect((await auth('/mfa/confirm', { code }, owner)).statusCode).toBe(409);
  expect((await security()).json().mfa_enabled).toBe(false);
});

it('expires challenges and persists failed attempts without issuing a session', async () => {
  const { codes } = await enroll();
  const expired = await challenge();

  await db.query(
    "UPDATE mfa_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [sha256(expired)],
  );

  expect((await auth('/mfa/challenge', { challenge: expired, code: codes[0] })).statusCode).toBe(
    403,
  );

  const id = await challenge();

  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await auth('/mfa/challenge', { challenge: id, code: 'bad-code' })).statusCode).toBe(
      403,
    );
  }

  await db.query('DELETE FROM login_attempts WHERE subject_hash=$1', [
    sha256(`mfa:${owner.userId}`),
  ]);

  const result = await auth('/mfa/challenge', { challenge: id, code: codes[0] });

  expect(result.statusCode).toBe(403);
  expect(result.headers['set-cookie']).toBeUndefined();

  expect(
    (await db.query('SELECT attempts FROM mfa_challenges WHERE token_hash=$1', [sha256(id)]))
      .rows[0].attempts,
  ).toBe(5);
});

it('requires password and MFA to replace recovery codes or disable the factor', async () => {
  const { codes } = await enroll();

  expect(
    (await auth('/mfa/disable', { current_password: 'incorrect', code: codes[0] }, owner))
      .statusCode,
  ).toBe(403);

  expect(
    (await auth('/mfa/disable', { current_password: password, code: 'bad-code' }, owner))
      .statusCode,
  ).toBe(403);

  const replacement = await auth(
    '/mfa/recovery-codes',
    { current_password: password, code: codes[0] },
    owner,
  );

  expect(replacement.statusCode, replacement.body).toBe(200);
  expect(replacement.json().recovery_codes).toHaveLength(10);

  expect(
    (await auth('/mfa/disable', { current_password: password, code: codes[1] }, owner)).statusCode,
  ).toBe(403);

  const disabled = await auth(
    '/mfa/disable',
    { current_password: password, code: replacement.json().recovery_codes[0] },
    owner,
  );

  expect(disabled.statusCode, disabled.body).toBe(200);
  expect((await api('/snapshot')).statusCode).toBe(401);

  expect(
    (await db.query('SELECT mfa_secret FROM users WHERE id=$1', [owner.userId])).rows[0].mfa_secret,
  ).toBeNull();
});

it('preserves MFA through password recovery and invalidates pending challenges', async () => {
  await enroll();
  const pending = await challenge();

  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  const link = await identityAdmin(db, ['reset-password', email], origin);

  const result = await auth('/reset-password', {
    token: new URL(link.link).hash.split('token=')[1],
    password: 'a replacement memorable password',
  });

  expect(result.statusCode).toBe(200);

  expect(
    (await db.query('SELECT 1 FROM mfa_challenges WHERE token_hash=$1', [sha256(pending)]))
      .rowCount,
  ).toBe(0);

  const next = await auth('/login', { email, password: 'a replacement memorable password' });

  expect(next.json().mfa_required).toBe(true);
  expect(next.headers['set-cookie']).toBeUndefined();
});

it('isolates session listings and revocations and enforces idle and absolute expiry', async () => {
  const other = await member();
  const others = (await security(other)).json().sessions;
  const current = (await security()).json().sessions;

  expect(current).toHaveLength(1);
  expect(current[0].current).toBe(true);
  expect(JSON.stringify(current)).not.toContain('token_hash');
  expect((await auth('/sessions/revoke', { id: others[0].id }, owner)).statusCode).toBe(404);

  expect(
    (await auth('/sessions/revoke', { others: true }, owner, { 'x-csrf-token': '' })).statusCode,
  ).toBe(403);

  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  const login = await auth('/login', { email, password });
  const second = await session(login.headers['set-cookie'] as string, f.org);

  expect((await auth('/sessions/revoke', { others: true }, owner)).json().revoked).toBe(1);
  expect((await api('/snapshot', undefined, second)).statusCode).toBe(401);
  expect((await api('/snapshot', undefined, other)).statusCode).toBe(200);

  await db.query(
    "UPDATE browser_sessions SET last_seen_at=now()-interval '61 minutes' WHERE id=$1",
    [current[0].id],
  );

  expect((await api('/snapshot')).statusCode).toBe(401);

  await db.query(
    `
      UPDATE browser_sessions
      SET
        last_seen_at = now(),
        expires_at = now() - interval '1 second'
      WHERE
        id = $1
    `,
    [current[0].id],
  );

  expect((await api('/snapshot')).statusCode).toBe(401);
});

it('supports operator MFA recovery with credential revocation and audit', async () => {
  await enroll();
  await challenge();
  const managed = await token();

  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  await identityAdmin(db, ['reset-mfa', email], origin);
  expect((await api('/snapshot')).statusCode).toBe(401);
  await expect(control.authenticate(managed.token)).rejects.toThrow();

  expect(
    (await db.query('SELECT 1 FROM mfa_recovery_codes WHERE user_id=$1', [owner.userId])).rowCount,
  ).toBe(0);

  expect(
    (await db.query('SELECT 1 FROM mfa_challenges WHERE user_id=$1', [owner.userId])).rowCount,
  ).toBe(0);

  expect(
    (
      await db.query(
        `
          SELECT
            1
          FROM
            audit_events
          WHERE
            organisation_id = $1
            AND action = 'account.mfa_reset_by_operator'
        `,
        [f.org],
      )
    ).rowCount,
  ).toBe(1);

  expect((await auth('/login', { email, password })).json().signed_in).toBe(true);
});

it('cancels pending setup and shares MFA attempt limits across API instances', async () => {
  expect((await auth('/mfa/enroll', { current_password: password }, owner)).statusCode).toBe(200);
  expect((await auth('/mfa/cancel', {}, owner)).statusCode).toBe(200);

  expect(
    (await db.query('SELECT 1 FROM mfa_enrollments WHERE user_id=$1', [owner.userId])).rowCount,
  ).toBe(0);

  expect((await auth('/mfa/confirm', { code: '123456' }, owner)).statusCode).toBe(409);
  const { codes } = await enroll();
  const id = await challenge();

  await db.query(
    `
      INSERT INTO
        login_attempts (subject_hash, attempts)
      VALUES
        ($1, 8)
      ON CONFLICT (subject_hash) DO UPDATE
      SET
        attempts = 8,
        window_start = now()
    `,
    [sha256(`mfa:${owner.userId}`)],
  );

  const secondApp = await createApp(control, false, undefined, undefined, origin);

  try {
    const result = await secondApp.inject({
      method: 'POST',
      url: '/api/auth/mfa/challenge',
      headers: { origin },
      payload: { challenge: id, code: codes[0] },
    });

    expect(result.statusCode).toBe(429);
    expect(result.headers['set-cookie']).toBeUndefined();
  } finally {
    await secondApp.close();
  }
});

it('caps retained sessions, supports self-revocation and keeps account controls available without memberships', async () => {
  await db.query(
    "UPDATE browser_sessions SET created_at=now()-interval '1 minute' WHERE user_id=$1",
    [owner.userId],
  );

  await db.query(
    `
      INSERT INTO
        browser_sessions (id, user_id, token_hash, expires_at)
      SELECT
        gen_random_uuid(),
        $1,
        gen_random_uuid()::text,
        now() + interval '12 hours'
      FROM
        generate_series(1, 24)
    `,
    [owner.userId],
  );

  const email = (await db.query('SELECT email FROM users WHERE id=$1', [owner.userId])).rows[0]
    .email;

  const login = await auth('/login', { email, password });
  const latest = await session(login.headers['set-cookie'] as string, f.org);

  expect((await api('/snapshot')).statusCode).toBe(401);
  await db.query('UPDATE memberships SET removed_at=now() WHERE user_id=$1', [owner.userId]);
  const listing = await security(latest);

  expect(listing.statusCode, listing.body).toBe(200);
  expect(listing.json().sessions).toHaveLength(25);
  expect((await api('/snapshot', undefined, latest)).statusCode).toBe(403);
  const current = listing.json().sessions.find((row: { current: boolean }) => row.current);
  const result = await auth('/sessions/revoke', { id: current.id }, latest);

  expect(result.json()).toMatchObject({ signed_out: true, revoked: 1 });
  expect(result.headers['set-cookie']).toContain('Max-Age=0');
  expect((await security(latest)).statusCode).toBe(401);
});

it('creates, assigns and updates custom roles without granting workspace administration', async () => {
  const created = await api('/identity/roles', {
    name: 'Release reviewers',
    permissions: ['read', 'write', 'approve'],
  });

  expect(created.statusCode, created.body).toBe(200);
  const role = created.json();
  const reviewer = await member(role.id);
  const credential = await token(reviewer, ['read', 'write', 'approve']);
  const oldPrincipal = await control.authenticate(credential.token);

  expect(
    (await api('/identity/roles', { name: 'Escalation', permissions: ['read'] }, reviewer))
      .statusCode,
  ).toBe(403);

  expect((await api('/identity/members', undefined, reviewer)).statusCode).toBe(403);

  expect((await api('/identity/roles')).json().items).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: role.id, builtin: false })]),
  );

  expect(
    (await api(`/identity/roles/${role.id}/archive`, { expected_revision: 1 })).json().error.code,
  ).toBe('ROLE_IN_USE');

  const updated = await api(`/identity/roles/${role.id}/update`, {
    name: 'Release reviewers',
    permissions: ['read', 'approve'],
    expected_revision: 1,
  });

  expect(updated.statusCode, updated.body).toBe(200);

  expect(
    (
      await api(`/identity/roles/${role.id}/update`, {
        name: 'Stale edit',
        permissions: ['read'],
        expected_revision: 1,
      })
    ).statusCode,
  ).toBe(409);

  expect((await api('/snapshot', undefined, reviewer)).json().principal.permissions).toEqual([
    'read',
    'approve',
  ]);

  expect((await bearer(credential.token)).json().principal.permissions).toEqual([
    'read',
    'approve',
  ]);

  expect(
    (await bearer(credential.token, '/projects', { name: 'Denied', slug: 'denied' })).statusCode,
  ).toBe(403);

  await expect(
    control.mutate(oldPrincipal, randomUUID(), 'stale-role', async () => ({ leaked: true })),
  ).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });

  expect((await api(`/identity/members/${reviewer.userId}`, { role: 'reader' })).statusCode).toBe(
    200,
  );

  expect(
    (await api(`/identity/roles/${role.id}/archive`, { expected_revision: 2 })).statusCode,
  ).toBe(200);

  expect((await api(`/identity/members/${reviewer.userId}`, { role: role.id })).statusCode).toBe(
    404,
  );

  expect(
    (await api('/identity/invitations', { email: 'archived@example.com', role: role.id }))
      .statusCode,
  ).toBe(404);
});

it('protects built-in roles, cross-workspace assignments and pending custom-role invitations', async () => {
  expect((await api('/identity/roles', { name: 'Owner', permissions: ['read'] })).statusCode).toBe(
    400,
  );

  expect((await api('/identity/roles', { name: 'Bad', permissions: ['write'] })).statusCode).toBe(
    400,
  );

  expect(
    (await api('/identity/roles', { name: 'Bad', permissions: ['read', 'manage_members'] }))
      .statusCode,
  ).toBe(400);

  const administrator = await member('admin');

  expect(
    (await api('/identity/roles', { name: 'No', permissions: ['read'] }, administrator)).statusCode,
  ).toBe(403);

  const role = (
    await api('/identity/roles', { name: 'Release observer', permissions: ['read'] })
  ).json();

  expect(
    (await api('/identity/roles', { name: 'release observer', permissions: ['read'] })).statusCode,
  ).toBe(409);

  const invitation = await invite(role.id);

  expect(
    (await api(`/identity/roles/${role.id}/archive`, { expected_revision: 1 })).statusCode,
  ).toBe(409);

  expect(
    (await api('/identity/invitations', { email: 'foreign@example.com', role: randomUUID() }))
      .statusCode,
  ).toBe(404);

  const other = await fixture(db);

  await expect(
    db.query('UPDATE workspace_invitations SET organisation_id=$1 WHERE id=$2', [
      other.org,
      invitation.id,
    ]),
  ).rejects.toMatchObject({ code: '23503' });

  await api(`/identity/invitations/${invitation.id}/revoke`, {});

  expect(
    (await api(`/identity/roles/${role.id}/archive`, { expected_revision: 1 })).statusCode,
  ).toBe(200);

  // Acceptance rechecks the role under the workspace lock, even if invitation state is stale.
  await db.query('UPDATE workspace_invitations SET revoked_at=NULL WHERE id=$1', [invitation.id]);

  const staleInvite = await auth('/accept', {
    token: invitation.token,
    name: 'Stale invitation',
    password,
  });

  expect(staleInvite.statusCode).toBe(404);
  expect(staleInvite.json().error.code).toBe('ROLE_NOT_FOUND');
});

async function scopedFixture() {
  const projects = [];

  for (const name of ['Allowed', 'Excluded']) {
    const project = (await api('/projects', { name, slug: name.toLowerCase() })).json();
    const bytes = Buffer.from(`artifact for ${name}`);

    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts?project_id=${project.id}&name=application&version=1&digest=${sha256(bytes)}`,
      payload: bytes,
      headers: {
        origin,
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
        'x-workspace-id': owner.workspace,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
    });

    expect(upload.statusCode, upload.body).toBe(200);

    const release = await api('/releases', {
      project_id: project.id,
      artifact_id: upload.json().id,
      version: '1',
      process: deploymentProcess(),
    });

    expect(release.statusCode, release.body).toBe(200);

    const deployment = await api('/deployments', {
      release_id: release.json().id,
      environment_id: f.environments.staging,
    });

    expect(deployment.statusCode, deployment.body).toBe(200);

    projects.push({
      ...project,
      artifact: upload.json(),
      release: release.json(),
      deployment: deployment.json(),
    });
  }

  const scoped = await api('/identity/tokens', {
    name: 'Project CI',
    permissions: ['read', 'write', 'approve', 'manage_secrets'],
    expires_in_days: 30,
    project_ids: [projects[0].id],
  });

  expect(scoped.statusCode, scoped.body).toBe(200);

  return { allowed: projects[0], excluded: projects[1], credential: scoped.json() };
}

it('filters scoped snapshots, counts, resource pages and artifact downloads', async () => {
  const { allowed, excluded, credential } = await scopedFixture();
  const snapshot = await bearer(credential.token);

  expect(snapshot.statusCode, snapshot.body).toBe(200);

  expect(snapshot.json().projects.map((project: { id: string }) => project.id)).toEqual([
    allowed.id,
  ]);

  expect(snapshot.json().totals).toMatchObject({
    projects: 1,
    artifacts: 1,
    releases: 1,
    deployments: 1,
    audit_events: 0,
  });

  expect(snapshot.json().audit).toEqual([]);
  expect(snapshot.json().environment_states).toHaveLength(1);
  expect(snapshot.body).not.toContain(excluded.id);
  expect(snapshot.json().environments).toHaveLength(2);

  for (const [resource, allowedId, deniedId] of [
    ['projects', allowed.id, excluded.id],
    ['artifacts', allowed.artifact.id, excluded.artifact.id],
    ['releases', allowed.release.id, excluded.release.id],
    ['deployments', allowed.deployment.id, excluded.deployment.id],
  ]) {
    const page = await bearer(credential.token, `/resources/${resource}?limit=1`);

    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().total).toBe(1);
    expect(page.json().items[0].id).toBe(allowedId);

    expect((await bearer(credential.token, `/resources/${resource}/${deniedId}`)).statusCode).toBe(
      404,
    );

    expect((await bearer(credential.token, `/resources/${resource}/${allowedId}`)).statusCode).toBe(
      200,
    );
  }

  expect((await bearer(credential.token, `/artifacts/${allowed.artifact.id}/download`)).body).toBe(
    'artifact for Allowed',
  );

  expect(
    (await bearer(credential.token, `/artifacts/${excluded.artifact.id}/download`)).statusCode,
  ).toBe(404);

  expect(
    (await bearer(credential.token, `/resources/deployments?project_id=${excluded.id}`)).json()
      .total,
  ).toBe(0);

  const broaderPage = (await api('/resources/projects?limit=1')).json();

  expect(
    (await bearer(credential.token, `/resources/projects?cursor=${broaderPage.next_cursor}`))
      .statusCode,
  ).toBe(400);

  for (const route of [
    '/integrations',
    '/execution',
    '/resources/audit',
    '/resources/agents',
    '/resources/targets',
    '/resources/attempts',
    '/resources/notification-deliveries',
    '/resources/notification-attempts',
  ]) {
    const response = await bearer(credential.token, route);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(excluded.id);
  }
});

it('enforces project scopes before writes, approval, rollback, secret access and replay', async () => {
  const { allowed, excluded, credential } = await scopedFixture();

  expect(
    (await bearer(credential.token, `/deployments/${allowed.deployment.id}/cancel`, {})).statusCode,
  ).toBe(200);

  for (const action of ['cancel', 'approve', 'reject']) {
    expect(
      (await bearer(credential.token, `/deployments/${excluded.deployment.id}/${action}`, {}))
        .statusCode,
    ).toBe(404);
  }

  for (const path of [
    `/deployments/${excluded.deployment.id}/rollback-candidates`,
    `/deployments/${excluded.deployment.id}/secret-bindings`,
    `/releases/${excluded.release.id}/promotion?environment_id=${f.environments.staging}`,
  ]) {
    expect((await bearer(credential.token, path)).statusCode).toBe(404);
  }

  expect(
    (
      await bearer(credential.token, '/rollback-plans', {
        source_deployment_id: allowed.deployment.id,
        candidate_deployment_id: excluded.deployment.id,
      })
    ).statusCode,
  ).toBe(404);

  expect(
    (
      await bearer(credential.token, '/deployments', {
        release_id: excluded.release.id,
        environment_id: f.environments.staging,
      })
    ).statusCode,
  ).toBe(404);

  expect(
    (
      await bearer(credential.token, '/releases', {
        project_id: excluded.id,
        artifact_id: excluded.artifact.id,
        version: '2',
        process: deploymentProcess(),
      })
    ).statusCode,
  ).toBe(403);

  expect(
    (
      await bearer(
        credential.token,
        `/secrets?project_id=${excluded.id}&environment_id=${f.environments.staging}`,
      )
    ).statusCode,
  ).toBe(403);

  expect((await bearer(credential.token, '/secrets', { project_id: excluded.id })).statusCode).toBe(
    403,
  );

  expect(
    (await bearer(credential.token, '/integrations/github', { project_id: excluded.id }))
      .statusCode,
  ).toBe(403);

  expect(
    (await bearer(credential.token, '/notifications/endpoints', { project_id: excluded.id }))
      .statusCode,
  ).toBe(403);

  for (const path of [
    '/projects',
    '/agents',
    '/targets',
    `/agents/${randomUUID()}/certificate`,
    `/environments/${f.environments.staging}/promotion-policy`,
    '/identity/tokens',
  ]) {
    expect((await bearer(credential.token, path, {})).statusCode).toBe(403);
  }

  const input = {
    project_id: allowed.id,
    artifact_id: allowed.artifact.id,
    version: '2',
    process: deploymentProcess(),
  };

  const key = randomUUID();

  expect((await api('/releases', input, owner, key)).statusCode).toBe(200);

  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/releases',
    payload: input,
    headers: { authorization: `Bearer ${credential.token}`, 'idempotency-key': key },
  });

  expect(replay.statusCode).toBe(409);
  const published = await bearer(credential.token, '/releases', { ...input, version: '3' });

  expect(published.statusCode, published.body).toBe(200);

  expect(
    (
      await bearer(credential.token, '/deployments', {
        release_id: published.json().id,
        environment_id: f.environments.staging,
      })
    ).statusCode,
  ).toBe(200);
});

it('validates project selection and preserves scope through token rotation', async () => {
  const { allowed, excluded, credential } = await scopedFixture();
  const input = { name: 'Scoped CI', permissions: ['read', 'write'], expires_in_days: 30 };
  const other = await fixture(db);
  const foreignId = randomUUID();

  await db.query('INSERT INTO projects(id, organisation_id, name, slug) VALUES($1,$2,$3,$4)', [
    foreignId,
    other.org,
    'Foreign',
    'foreign',
  ]);

  for (const project_ids of [[], [allowed.id, allowed.id], [null]]) {
    expect((await api('/identity/tokens', { ...input, project_ids })).statusCode).toBe(400);
  }

  expect((await api('/identity/tokens', { ...input, project_ids: [foreignId] })).statusCode).toBe(
    404,
  );

  expect(
    (await api('/identity/tokens', { ...input, project_ids: [randomUUID()] })).statusCode,
  ).toBe(404);

  const rotated = await api(`/identity/tokens/${credential.id}/rotate`, input);

  expect(rotated.statusCode, rotated.body).toBe(200);
  expect(rotated.json().project_ids).toEqual([allowed.id]);
  expect((await bearer(credential.token)).statusCode).toBe(401);

  expect(
    (await bearer(rotated.json().token, `/resources/projects/${excluded.id}`)).statusCode,
  ).toBe(404);

  const multiple = await api('/identity/tokens', {
    ...input,
    project_ids: [allowed.id, excluded.id],
  });

  expect((await bearer(multiple.json().token, '/resources/projects')).json().total).toBe(2);
  const listing = (await api('/identity/tokens')).json();

  expect(
    listing.items.find((item: { id: string }) => item.id === rotated.json().id).project_ids,
  ).toEqual([allowed.id]);
});

it('isolates integration, execution and notification metadata and related mutations', async () => {
  const { allowed, excluded, credential } = await scopedFixture();
  const created = [];

  for (const project of [allowed, excluded]) {
    const agent = randomUUID();
    const target = randomUUID();
    const attempt = randomUUID();
    const connection = randomUUID();
    const imported = randomUUID();
    const endpoint = randomUUID();
    const delivery = randomUUID();
    const notificationAttempt = randomUUID();

    const event = (
      await db.query('SELECT id FROM deployment_events WHERE deployment_id=$1', [
        project.deployment.id,
      ])
    ).rows[0].id;

    await db.query(
      'INSERT INTO deployment_agents(id,organisation_id,name,certificate_fingerprint) VALUES($1,$2,$3,$4)',
      [agent, f.org, project.name, sha256(agent)],
    );

    await db.query(
      `
      INSERT INTO
        deployment_targets (
          id,
          organisation_id,
          project_id,
          environment_id,
          agent_id,
          name,
          labels
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
    `,
      [target, f.org, project.id, f.environments.staging, agent, project.name, {}],
    );

    await db.query(
      'INSERT INTO deployment_attempts(id,organisation_id,deployment_id,target_id,agent_id,state) VALUES($1,$2,$3,$4,$5,$6)',
      [attempt, f.org, project.deployment.id, target, agent, 'failed'],
    );

    await db.query(
      `
      INSERT INTO
        provider_connections (
          id,
          organisation_id,
          project_id,
          created_by,
          provider,
          name,
          repository,
          repository_id,
          workflow_id,
          branch,
          artifact_name,
          credentials
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'github-actions',
          $5,
          'owner/repo',
          '1',
          '1',
          'main',
          'application',
          '{}'
        )
    `,
      [connection, f.org, project.id, f.operator.id, project.name],
    );

    await db.query(
      `
      INSERT INTO
        artifact_imports (
          id,
          organisation_id,
          project_id,
          connection_id,
          requested_by,
          run_id,
          run_attempt,
          status
        )
      VALUES
        ($1, $2, $3, $4, $5, '1', 1, 'failed')
    `,
      [imported, f.org, project.id, connection, f.operator.id],
    );

    await db.query(
      `
      INSERT INTO
        notification_endpoints (
          id,
          organisation_id,
          name,
          origin,
          credentials,
          project_id,
          statuses
        )
      VALUES
        (
          $1,
          $2,
          $3,
          'https://example.com',
          '{}',
          $4,
          '{failed}'
        )
    `,
      [endpoint, f.org, project.name, project.id],
    );

    await db.query(
      `
      INSERT INTO
        notification_deliveries (
          id,
          organisation_id,
          endpoint_id,
          event_id,
          deployment_id,
          payload,
          status
        )
      VALUES
        ($1, $2, $3, $4, $5, '{}', 'failed')
    `,
      [delivery, f.org, endpoint, event, project.deployment.id],
    );

    await db.query(
      'INSERT INTO notification_attempts(id,organisation_id,delivery_id,attempt) VALUES($1,$2,$3,1)',
      [notificationAttempt, f.org, delivery],
    );

    created.push({
      agents: agent,
      targets: target,
      attempts: attempt,
      connections: connection,
      imports: imported,
      'notification-endpoints': endpoint,
      'notification-deliveries': delivery,
      'notification-attempts': notificationAttempt,
    });
  }

  for (const resource of Object.keys(created[0]) as (keyof (typeof created)[0])[]) {
    const page = await bearer(credential.token, `/resources/${resource}`);

    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().total).toBe(1);
    expect(page.json().items[0].id).toBe(created[0][resource]);

    expect(
      (await bearer(credential.token, `/resources/${resource}/${created[1][resource]}`)).statusCode,
    ).toBe(404);
  }

  const execution = (await bearer(credential.token, '/execution')).json();
  const integrations = (await bearer(credential.token, '/integrations')).json();

  expect(execution.agents.map((row: { id: string }) => row.id)).toEqual([created[0].agents]);
  expect(execution.targets.map((row: { id: string }) => row.id)).toEqual([created[0].targets]);
  expect(execution.attempts.map((row: { id: string }) => row.id)).toEqual([created[0].attempts]);

  expect(integrations.connections.map((row: { id: string }) => row.id)).toEqual([
    created[0].connections,
  ]);

  expect(integrations.imports.map((row: { id: string }) => row.id)).toEqual([created[0].imports]);
  const deniedConnection = created[1].connections;

  for (const action of ['state', 'credentials', 'bitbucket-credentials', 'imports']) {
    expect(
      (await bearer(credential.token, `/integrations/${deniedConnection}/${action}`, {}))
        .statusCode,
    ).toBe(404);
  }

  expect(
    (await bearer(credential.token, `/integrations/${deniedConnection}/pipelines`)).statusCode,
  ).toBe(404);

  expect(
    (await bearer(credential.token, `/imports/${created[1].imports}/retry`, {})).statusCode,
  ).toBe(404);

  expect(
    (
      await bearer(
        credential.token,
        `/notifications/endpoints/${created[1]['notification-endpoints']}/state`,
        { enabled: false, expected_revision: 1 },
      )
    ).statusCode,
  ).toBe(404);

  expect(
    (
      await bearer(
        credential.token,
        `/notifications/deliveries/${created[1]['notification-deliveries']}/retry`,
        {},
      )
    ).statusCode,
  ).toBe(404);

  expect(
    (
      await bearer(
        credential.token,
        `/notifications/deliveries/${created[0]['notification-deliveries']}/retry`,
        {},
      )
    ).statusCode,
  ).toBe(200);

  expect(
    (
      await bearer(credential.token, `/integrations/${created[0].connections}/state`, {
        enabled: false,
      })
    ).statusCode,
  ).toBe(200);

  // A workspace-wide endpoint must remain inaccessible even when one delivery belongs to an allowed project.
  await db.query('UPDATE notification_endpoints SET project_id=NULL WHERE id=$1', [
    created[0]['notification-endpoints'],
  ]);

  expect((await bearer(credential.token, '/resources/notification-deliveries')).json().total).toBe(
    0,
  );

  expect((await bearer(credential.token, '/resources/notification-attempts')).json().total).toBe(0);

  expect(
    (
      await bearer(
        credential.token,
        `/notifications/endpoints/${created[0]['notification-endpoints']}/state`,
        { enabled: false, expected_revision: 1 },
      )
    ).statusCode,
  ).toBe(404);
});

async function environmentFixture() {
  const { allowed, excluded } = await scopedFixture();
  const deployments = [];

  for (const project of [allowed, excluded]) {
    const response = await api('/deployments', {
      release_id: project.release.id,
      environment_id: f.environments.production,
    });

    expect(response.statusCode, response.body).toBe(200);
    deployments.push(response.json());
  }

  const input = {
    name: 'Production CI',
    permissions: ['read', 'write', 'approve', 'manage_secrets'],
    expires_in_days: 30,
    project_ids: [allowed.id],
    environment_ids: [f.environments.production],
  };

  const issued = await api('/identity/tokens', input);

  expect(issued.statusCode, issued.body).toBe(200);

  return { allowed, excluded, deployments, input, credential: issued.json() };
}

it('validates environment selection and preserves both scopes on rotation', async () => {
  const { input, credential, allowed } = await environmentFixture();
  const foreign = await fixture(db);

  for (const environment_ids of [
    [],
    [null],
    ['invalid'],
    Array(101).fill(randomUUID()),
    [f.environments.production, f.environments.production],
    [f.environments.production, f.environments.production.toUpperCase()],
  ]) {
    expect((await api('/identity/tokens', { ...input, environment_ids })).statusCode).toBe(400);
  }

  for (const id of [foreign.environments.production, randomUUID()]) {
    expect((await api('/identity/tokens', { ...input, environment_ids: [id] })).statusCode).toBe(
      404,
    );
  }

  const uppercase = await api('/identity/tokens', {
    ...input,
    environment_ids: [f.environments.production.toUpperCase()],
  });

  expect(uppercase.statusCode, uppercase.body).toBe(200);
  expect(uppercase.json().environment_ids).toEqual(input.environment_ids);

  expect(
    (
      await bearer(
        uppercase.json().token,
        `/releases/${allowed.release.id}/promotion?environment_id=${f.environments.production.toUpperCase()}`,
      )
    ).statusCode,
  ).toBe(200);

  // A failed replacement must not revoke the working credential.
  expect(
    (
      await api(`/identity/tokens/${credential.id}/rotate`, {
        ...input,
        environment_ids: [foreign.environments.production],
      })
    ).statusCode,
  ).toBe(404);

  expect((await bearer(credential.token)).statusCode).toBe(200);

  const { project_ids: _projects, environment_ids: _environments, ...unscoped } = input;
  const rotated = await api(`/identity/tokens/${credential.id}/rotate`, unscoped);

  expect(rotated.statusCode, rotated.body).toBe(200);

  expect(rotated.json()).toMatchObject({
    project_ids: [allowed.id],
    environment_ids: input.environment_ids,
  });

  expect((await bearer(credential.token)).statusCode).toBe(401);

  const listed = (await api('/identity/tokens'))
    .json()
    .items.find((row: { id: string }) => row.id === rotated.json().id);

  expect(listed.environment_ids).toEqual(input.environment_ids);
  expect(listed.token).toBeUndefined();

  const expanded = await api(`/identity/tokens/${rotated.json().id}/rotate`, {
    ...unscoped,
    environment_ids: null,
  });

  expect(expanded.statusCode, expanded.body).toBe(200);
  expect(expanded.json().project_ids).toEqual([allowed.id]);
  expect(expanded.json().environment_ids).toBeNull();
  expect((await bearer(expanded.json().token)).json().environments).toHaveLength(2);
});

it('intersects environment and project scope across snapshots, pages, actions and replay', async () => {
  const { allowed, excluded, deployments, credential, input } = await environmentFixture();
  const snapshot = await bearer(credential.token);

  expect(snapshot.statusCode, snapshot.body).toBe(200);
  expect(snapshot.json().principal.environment_ids).toEqual(input.environment_ids);

  expect(snapshot.json().totals).toMatchObject({
    projects: 1,
    deployments: 1,
    environments: 1,
    audit_events: 0,
  });

  expect(snapshot.json().awaiting_approval).toBe(1);
  expect(snapshot.json().environment_states).toHaveLength(1);
  expect(snapshot.body).not.toContain(excluded.id);
  expect(snapshot.body).not.toContain(allowed.deployment.id);
  expect(snapshot.body).not.toContain(f.environments.staging);

  for (const [resource, id] of [
    ['deployments', deployments[0].id],
    ['environments', f.environments.production],
  ]) {
    const response = await bearer(credential.token, `/resources/${resource}`);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().total).toBe(1);
    expect(response.json().items[0].id).toBe(id);
    expect((await bearer(credential.token, `/resources/${resource}/${id}`)).statusCode).toBe(200);
  }

  for (const id of [allowed.deployment.id, deployments[1].id]) {
    expect((await bearer(credential.token, `/resources/deployments/${id}`)).statusCode).toBe(404);

    for (const action of ['approve', 'reject', 'cancel']) {
      expect((await bearer(credential.token, `/deployments/${id}/${action}`, {})).statusCode).toBe(
        404,
      );
    }

    for (const action of ['rollback-candidates', 'secret-bindings']) {
      expect((await bearer(credential.token, `/deployments/${id}/${action}`)).statusCode).toBe(404);
    }
  }

  expect(
    (await bearer(credential.token, `/resources/environments/${f.environments.staging}`))
      .statusCode,
  ).toBe(404);

  expect(
    (
      await bearer(
        credential.token,
        `/resources/deployments?environment_id=${f.environments.staging}`,
      )
    ).json().total,
  ).toBe(0);

  expect(
    (await bearer(credential.token, `/deployments/${deployments[0].id}/cancel`, {})).statusCode,
  ).toBe(200);

  expect(
    (
      await bearer(credential.token, '/rollback-plans', {
        source_deployment_id: deployments[0].id,
        candidate_deployment_id: allowed.deployment.id,
      })
    ).statusCode,
  ).toBe(404);

  expect(
    (
      await bearer(credential.token, '/deployments', {
        release_id: allowed.release.id,
        environment_id: f.environments.staging,
      })
    ).statusCode,
  ).toBe(403);

  expect(
    (
      await bearer(credential.token, '/deployments', {
        release_id: excluded.release.id,
        environment_id: f.environments.production,
      })
    ).statusCode,
  ).toBe(404);

  const request = { release_id: allowed.release.id, environment_id: f.environments.production };
  const key = randomUUID();

  const broadDeployment = await api('/deployments', request, owner, key);

  expect(broadDeployment.statusCode, broadDeployment.body).toBe(200);

  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/deployments',
    payload: request,
    headers: { authorization: `Bearer ${credential.token}`, 'idempotency-key': key },
  });

  expect(replay.statusCode).toBe(409);
  expect((await api(`/deployments/${broadDeployment.json().id}/cancel`, {})).statusCode).toBe(200);
  const restrictedDeployment = await bearer(credential.token, '/deployments', request);

  expect(restrictedDeployment.statusCode, restrictedDeployment.body).toBe(200);

  const environmentOnly = await api('/identity/tokens', { ...input, project_ids: null });
  const page = await bearer(environmentOnly.json().token, '/resources/deployments?limit=1');

  expect(page.json().total).toBe(4);
  expect(page.json().next_cursor).toBeTruthy();

  expect(
    (await bearer(credential.token, `/resources/deployments?cursor=${page.json().next_cursor}`))
      .statusCode,
  ).toBe(400);

  const projectOnly = await api('/identity/tokens', {
    ...input,
    environment_ids: null,
    project_ids: null,
  });

  const broadPage = await bearer(projectOnly.json().token, '/resources/deployments?limit=1');

  expect(
    (
      await bearer(
        environmentOnly.json().token,
        `/resources/deployments?cursor=${broadPage.json().next_cursor}`,
      )
    ).statusCode,
  ).toBe(400);

  // Shared immutable inputs remain readable; a restricted credential cannot publish new inputs.
  expect(
    (await bearer(credential.token, `/artifacts/${allowed.artifact.id}/download`)).statusCode,
  ).toBe(200);

  for (const path of [
    '/projects',
    '/agents',
    '/targets',
    '/releases',
    '/integrations/github',
    '/integrations/bitbucket',
    `/environments/${f.environments.production}/promotion-policy`,
    `/integrations/${randomUUID()}/state`,
    `/imports/${randomUUID()}/retry`,
  ]) {
    expect(
      (await bearer(environmentOnly.json().token, path, { project_id: allowed.id })).statusCode,
    ).toBe(403);
  }

  expect((await bearer(credential.token, '/integrations')).json()).toMatchObject({
    connections: [],
    imports: [],
  });
});

it('limits secret metadata and changes to selected environments', async () => {
  const { allowed, credential } = await environmentFixture();
  const secrets = [];

  for (const environment_id of [f.environments.staging, f.environments.production]) {
    const result = await api('/secrets', {
      project_id: allowed.id,
      environment_id,
      name: 'API_KEY',
      value: 'do-not-expose',
    });

    expect(result.statusCode, result.body).toBe(200);
    secrets.push(result.json());
  }

  const query = `project_id=${allowed.id}&environment_id=${f.environments.production}`;
  const metadata = await bearer(credential.token, `/secrets?${query}`);

  expect(metadata.statusCode, metadata.body).toBe(200);
  expect(metadata.body).not.toContain('do-not-expose');
  expect((await bearer(credential.token, `/resources/secrets?${query}`)).json().total).toBe(1);

  expect((await bearer(credential.token, `/resources/secrets/${secrets[0].id}`)).statusCode).toBe(
    404,
  );

  expect(
    (
      await bearer(
        credential.token,
        `/secrets?project_id=${allowed.id}&environment_id=${f.environments.staging}`,
      )
    ).statusCode,
  ).toBe(403);

  expect(
    (
      await bearer(credential.token, '/secrets', {
        project_id: allowed.id,
        environment_id: f.environments.staging,
      })
    ).statusCode,
  ).toBe(403);

  for (const action of ['versions', 'revoke']) {
    expect(
      (await bearer(credential.token, `/secrets/${secrets[0].id}/${action}`, {})).statusCode,
    ).toBe(404);
  }

  const changed = await bearer(credential.token, `/secrets/${secrets[1].id}/versions`, {
    expected_revision: 1,
    value: 'replacement',
  });

  expect(changed.statusCode, changed.body).toBe(200);

  expect(
    (await bearer(credential.token, `/secrets/${secrets[1].id}/revoke`, { expected_revision: 2 }))
      .statusCode,
  ).toBe(200);
});

it('filters execution and notification relationships using the same allowed project and environment', async () => {
  const { allowed, excluded, deployments, credential } = await environmentFixture();
  const rows = [];

  for (const [project, deployment, environment] of [
    [allowed, deployments[0], f.environments.production],
    [allowed, allowed.deployment, f.environments.staging],
    [excluded, deployments[1], f.environments.production],
  ] as const) {
    const agent = randomUUID();
    const target = randomUUID();
    const attempt = randomUUID();
    const endpoint = randomUUID();
    const delivery = randomUUID();
    const notificationAttempt = randomUUID();

    const event = (
      await db.query('SELECT id FROM deployment_events WHERE deployment_id=$1', [deployment.id])
    ).rows[0].id;

    await db.query(
      'INSERT INTO deployment_agents(id,organisation_id,name,certificate_fingerprint) VALUES($1,$2,$3,$4)',
      [agent, f.org, 'Agent', sha256(agent)],
    );

    await db.query(
      `INSERT INTO deployment_targets(id,organisation_id,project_id,environment_id,agent_id,name,labels)
      VALUES($1,$2,$3,$4,$5,'Target','{}')`,
      [target, f.org, project.id, environment, agent],
    );

    await db.query(
      `INSERT INTO deployment_attempts(id,organisation_id,deployment_id,target_id,agent_id,state)
      VALUES($1,$2,$3,$4,$5,'failed')`,
      [attempt, f.org, deployment.id, target, agent],
    );

    await db.query(
      `INSERT INTO notification_endpoints(id,organisation_id,name,origin,credentials,project_id,environment_id,statuses)
      VALUES($1,$2,'Endpoint','https://example.com','{}',$3,$4,'{failed}')`,
      [endpoint, f.org, project.id, environment],
    );

    await db.query(
      `INSERT INTO notification_deliveries(id,organisation_id,endpoint_id,event_id,deployment_id,payload,status)
      VALUES($1,$2,$3,$4,$5,'{}','failed')`,
      [delivery, f.org, endpoint, event, deployment.id],
    );

    await db.query(
      'INSERT INTO notification_attempts(id,organisation_id,delivery_id,attempt) VALUES($1,$2,$3,1)',
      [notificationAttempt, f.org, delivery],
    );

    rows.push({
      agents: agent,
      targets: target,
      attempts: attempt,
      'notification-endpoints': endpoint,
      'notification-deliveries': delivery,
      'notification-attempts': notificationAttempt,
    });
  }

  const connection = randomUUID();
  const imported = randomUUID();

  await db.query(
    `INSERT INTO provider_connections (
      id, organisation_id, project_id, created_by, provider, name, repository,
      repository_id, workflow_id, branch, artifact_name, credentials
    ) VALUES ($1, $2, $3, $4, 'github-actions', 'Shared CI', 'owner/repo', '1', '1', 'main', 'application', '{}')`,
    [connection, f.org, allowed.id, f.operator.id],
  );

  await db.query(
    `INSERT INTO artifact_imports (
      id, organisation_id, project_id, connection_id, requested_by, run_id, run_attempt, status
    ) VALUES ($1, $2, $3, $4, $5, '1', 1, 'failed')`,
    [imported, f.org, allowed.id, connection, f.operator.id],
  );

  for (const [resource, id] of [
    ['connections', connection],
    ['imports', imported],
  ]) {
    expect((await bearer(credential.token, `/resources/${resource}`)).json().total).toBe(0);
    expect((await bearer(credential.token, `/resources/${resource}/${id}`)).statusCode).toBe(404);
  }

  expect((await bearer(credential.token, '/integrations')).json()).toMatchObject({
    connections: [],
    imports: [],
  });

  expect(
    (await bearer(credential.token, `/integrations/${connection}/state`, { enabled: false }))
      .statusCode,
  ).toBe(403);

  expect((await bearer(credential.token, `/imports/${imported}/retry`, {})).statusCode).toBe(403);

  // This agent has the right project on one target, and the right environment on another.
  await db.query('UPDATE deployment_targets SET agent_id=$1 WHERE id=$2', [
    rows[1].agents,
    rows[2].targets,
  ]);

  for (const resource of Object.keys(rows[0]) as (keyof (typeof rows)[0])[]) {
    const page = await bearer(credential.token, `/resources/${resource}`);

    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().total).toBe(1);
    expect(page.json().items[0].id).toBe(rows[0][resource]);

    for (const row of rows.slice(1)) {
      expect(
        (await bearer(credential.token, `/resources/${resource}/${row[resource]}`)).statusCode,
      ).toBe(404);
    }
  }

  const execution = await bearer(credential.token, '/execution');

  expect(execution.statusCode, execution.body).toBe(200);

  for (const resource of ['agents', 'targets', 'attempts'] as const) {
    expect(execution.json()[resource].map((row: { id: string }) => row.id)).toEqual([
      rows[0][resource],
    ]);
  }

  for (const row of rows.slice(1)) {
    expect(
      (
        await bearer(
          credential.token,
          `/notifications/endpoints/${row['notification-endpoints']}/state`,
          {},
        )
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await bearer(
          credential.token,
          `/notifications/deliveries/${row['notification-deliveries']}/retry`,
          {},
        )
      ).statusCode,
    ).toBe(404);
  }

  expect(
    (await bearer(credential.token, '/notifications/endpoints', { project_id: allowed.id }))
      .statusCode,
  ).toBe(403);

  expect(
    (
      await bearer(credential.token, '/notifications/endpoints', {
        project_id: allowed.id,
        environment_id: f.environments.staging,
      })
    ).statusCode,
  ).toBe(403);

  expect(
    (
      await bearer(
        credential.token,
        `/notifications/deliveries/${rows[0]['notification-deliveries']}/retry`,
        {},
      )
    ).statusCode,
  ).toBe(200);

  // Global endpoints and their histories remain hidden, even for a permitted deployment.
  await db.query('UPDATE notification_endpoints SET environment_id=NULL WHERE id=$1', [
    rows[0]['notification-endpoints'],
  ]);

  for (const resource of [
    'notification-endpoints',
    'notification-deliveries',
    'notification-attempts',
  ]) {
    expect((await bearer(credential.token, `/resources/${resource}`)).json().total).toBe(0);
  }

  expect(
    (
      await bearer(
        credential.token,
        `/notifications/deliveries/${rows[0]['notification-deliveries']}/retry`,
        {},
      )
    ).statusCode,
  ).toBe(404);
});

it('evaluates promotion policy without exposing prerequisite environment evidence', async () => {
  const { allowed, deployments, input, credential } = await environmentFixture();
  const target = randomUUID();
  const agent = randomUUID();

  await api(`/deployments/${deployments[0].id}/cancel`, {});

  await db.query(
    `UPDATE deployments SET status='succeeded', result_code='HTTP_VERIFIED' WHERE id=$1`,
    [allowed.deployment.id],
  );

  await db.query(
    'INSERT INTO deployment_agents(id,organisation_id,name,certificate_fingerprint) VALUES($1,$2,$3,$4)',
    [agent, f.org, 'Prerequisite agent', sha256(agent)],
  );

  await db.query(
    `INSERT INTO deployment_targets(id,organisation_id,project_id,environment_id,agent_id,name,labels)
    VALUES($1,$2,$3,$4,$5,'Prerequisite target','{}')`,
    [target, f.org, allowed.id, f.environments.staging, agent],
  );

  await db.query(
    `INSERT INTO deployment_attempts(id,organisation_id,deployment_id,target_id,agent_id,state,result_code,fence)
    VALUES($1,$2,$3,$4,$5,'succeeded','HTTP_VERIFIED',1)`,
    [randomUUID(), f.org, allowed.deployment.id, target, agent],
  );

  const policy = await api(`/environments/${f.environments.production}/promotion-policy`, {
    promotion_from_environment_id: f.environments.staging,
    expected_revision: 1,
  });

  expect(policy.statusCode, policy.body).toBe(200);
  const promotionPath = `/releases/${allowed.release.id}/promotion?environment_id=${f.environments.production}`;
  const inspected = await bearer(credential.token, promotionPath);

  expect(inspected.statusCode, inspected.body).toBe(200);

  expect(inspected.json()).toMatchObject({
    eligible: true,
    source_deployment_id: null,
    promotion_from_environment_id: null,
    prerequisite_restricted: true,
  });

  expect(
    (
      await bearer(
        credential.token,
        `/releases/${allowed.release.id}/promotion?environment_id=${f.environments.staging}`,
      )
    ).statusCode,
  ).toBe(403);

  const request = { release_id: allowed.release.id, environment_id: f.environments.production };
  const key = randomUUID();

  const deploy = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/deployments',
      payload: request,
      headers: { authorization: `Bearer ${credential.token}`, 'idempotency-key': key },
    });

  const created = await deploy();

  expect(created.statusCode, created.body).toBe(200);
  expect(created.json().promotion_source_deployment_id).toBeNull();
  expect(created.json().policy_snapshot.promotion_from_environment_id).toBeNull();
  expect((await deploy()).json().promotion_source_deployment_id).toBeNull();

  for (const path of [
    '/snapshot',
    '/resources/environments',
    '/resources/deployments',
    `/resources/environments/${f.environments.production}`,
    `/resources/deployments/${created.json().id}`,
  ]) {
    const result = await bearer(credential.token, path);

    expect(result.statusCode, result.body).toBe(200);
    expect(result.body).not.toContain(f.environments.staging);
    expect(result.body).not.toContain(allowed.deployment.id);
    expect(result.body).not.toContain('Staging');
  }

  const broad = await api('/identity/tokens', {
    ...input,
    environment_ids: [f.environments.production, f.environments.staging],
  });

  expect((await bearer(broad.json().token, promotionPath)).json().source_deployment_id).toBe(
    allowed.deployment.id,
  );

  expect(
    (await api(`/resources/deployments/${created.json().id}`)).json()
      .promotion_source_deployment_id,
  ).toBe(allowed.deployment.id);

  // Environment scope never grants permissions excluded by the token.
  const reader = await api('/identity/tokens', { ...input, permissions: ['read'] });

  expect(
    (await bearer(reader.json().token, `/deployments/${created.json().id}/cancel`, {})).statusCode,
  ).toBe(403);

  expect((await api(`/resources/deployments/${created.json().id}`)).json().status).toBe(
    'awaiting_approval',
  );
});
