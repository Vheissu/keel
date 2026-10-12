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
import { fixture, testDatabaseUrl } from '../fixtures.js';

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
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-identity-'));
  control = new ControlPlane(db, new LocalArtifactStore(root));
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
    "UPDATE login_attempts SET window_start=now()-interval '2 minutes' WHERE subject_hash=$1",
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
      "INSERT INTO api_tokens(id,organisation_id,actor_id,user_id,token_hash,permissions,name,expires_at) VALUES($1,$2,$3,$4,$5,ARRAY['read'],'Racing token',now()+interval '1 day')",
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
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE id=%' AND pid<>pg_backend_pid()",
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
