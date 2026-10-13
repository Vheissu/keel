import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { migrate } from '../../packages/database/src/migrate.js';
import { fixture, testDatabaseUrl, deploymentProcess } from '../fixtures.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore, sha256 } from '../../apps/api/src/artifact-store.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { ExecutionService } from '../../apps/api/src/execution-service.js';
import { verify, quarantine, quiescent } from '../../apps/operations/src/recovery.js';

let admin: pg.Pool;
let db: pg.Pool;
let root: string;
let schema: string;
let f: Awaited<ReturnType<typeof fixture>>;
let control: ControlPlane;

beforeEach(async () => {
  schema = `recovery_${randomUUID().replaceAll('-', '')}`;
  admin = new pg.Pool({ connectionString: testDatabaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-recovery-'));
  vi.stubEnv('ARTIFACT_PATH', root);
  vi.stubEnv('ARTIFACT_STORE', 'local');
  vi.stubEnv('KEEL_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('KEEL_DEPLOYMENT_SECRET_KEY', randomBytes(32).toString('base64'));
  f = await fixture(db);

  control = new ControlPlane(
    db,
    new LocalArtifactStore(root),
    new CredentialVault(process.env.KEEL_DEPLOYMENT_SECRET_KEY!, 'deployment-secrets'),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.end();
  await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin?.end();
  await rm(root, { recursive: true, force: true });
});

it('verifies all retained artifacts and encrypted versions and fails for corruption or a wrong key', async () => {
  const principal = await control.authenticate(f.operator.token);

  const mutate = (work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(principal, randomUUID(), randomUUID(), work);

  const project = (await mutate((tx) =>
    control.project(tx, principal, { name: 'Recovery', slug: 'recovery', description: '' }),
  )) as { id: string };

  const bytes = Buffer.from('retained recovery artifact');
  const digest = sha256(bytes);

  await control.store.put(f.org, digest, bytes);

  await db.query(
    `
      INSERT INTO
        artifacts (
          id,
          organisation_id,
          project_id,
          name,
          version,
          digest,
          size,
          provenance
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [randomUUID(), f.org, project.id, 'artifact', '1', digest, bytes.length, {}],
  );

  await mutate((tx) =>
    control.secrets.create(tx, principal, {
      project_id: project.id,
      environment_id: f.environments.staging,
      name: 'PASSWORD',
      value: 'private',
    }),
  );

  expect(await verify(db)).toMatchObject({ migrations: 11, artifacts: 1, secret_versions: 1 });
  vi.stubEnv('KEEL_DEPLOYMENT_SECRET_KEY', randomBytes(32).toString('base64'));
  await expect(verify(db)).rejects.toThrow('decrypt');
  await writeFile(join(root, f.org, digest), 'tampered');
  await expect(verify(db)).rejects.toThrow('SHA-256');
});

it('revokes restored agents, removes target verification and appends a recovery audit event', async () => {
  const principal = await control.authenticate(f.operator.token);

  const mutate = (work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(principal, randomUUID(), randomUUID(), work);

  const project = (await mutate((tx) =>
    control.project(tx, principal, { name: 'Recovery', slug: 'recovery', description: '' }),
  )) as { id: string };

  const execution = new ExecutionService(control);
  const fingerprint = randomBytes(32).toString('hex');

  const agent = (await mutate((tx) =>
    execution.registerAgent(tx, principal, {
      name: 'Restored agent',
      certificate_fingerprint: fingerprint,
    }),
  )) as { id: string };

  const target = (await mutate((tx) =>
    execution.registerTarget(tx, principal, {
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: agent.id,
      name: 'Target',
      labels: { tier: 'staging' },
    }),
  )) as { id: string };

  await db.query("UPDATE deployment_targets SET current_state='verified', fence=42 WHERE id=$1", [
    target.id,
  ]);

  expect(await quarantine(db)).toEqual({ agents_revoked: 1, targets_unknown: 1 });
  await expect(execution.authenticate(fingerprint)).rejects.toThrow();

  expect(
    (await db.query('SELECT current_state, fence FROM deployment_targets WHERE id=$1', [target.id]))
      .rows[0],
  ).toEqual({ current_state: 'unknown', fence: 42 });

  expect(
    (await db.query("SELECT 1 FROM audit_events WHERE action='installation.restored'")).rowCount,
  ).toBe(1);

  expect(await quiescent(db)).toEqual({ deployments: 0, attempts: 0, imports: 0 });
});

it('refuses a clean stop while a deployment is queued or running', async () => {
  const principal = await control.authenticate(f.operator.token);

  const mutate = (work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(principal, randomUUID(), randomUUID(), work);

  const project = (await mutate((tx) =>
    control.project(tx, principal, { name: 'Busy', slug: 'busy', description: '' }),
  )) as { id: string };

  const artifact = (await mutate((tx) =>
    control.artifact(
      tx,
      principal,
      {
        project_id: project.id,
        name: 'application',
        version: '1',
        digest: sha256('busy artifact'),
      },
      Buffer.from('busy artifact'),
    ),
  )) as { id: string };

  const release = (await mutate((tx) =>
    control.release(tx, principal, {
      project_id: project.id,
      artifact_id: artifact.id,
      version: '1',
      process: deploymentProcess(),
    }),
  )) as { id: string };

  const deployment = (await mutate((tx) =>
    control.deploy(tx, principal, {
      release_id: release.id,
      environment_id: f.environments.staging,
    }),
  )) as { id: string };

  await expect(quiescent(db)).rejects.toThrow('active work');
  await db.query("UPDATE deployments SET status='running' WHERE id=$1", [deployment.id]);
  await expect(quiescent(db)).rejects.toThrow('active work');
});

it('verifies retained MFA secrets and quarantines recovery codes, challenges and pending setup', async () => {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const vault = new CredentialVault(process.env.KEEL_CREDENTIAL_KEY!, 'mfa');
  const encrypted = vault.encrypt(userId, 'totp', randomBytes(20).toString('base64'));

  await db.query(
    `
      INSERT INTO
        users (
          id,
          email,
          name,
          password_hash,
          mfa_secret,
          mfa_enabled_at
        )
      VALUES
        ($1, 'mfa@example.com', 'MFA', 'unused', $2, now())
    `,
    [userId, encrypted],
  );

  await db.query(
    `
      INSERT INTO
        browser_sessions (id, user_id, token_hash, expires_at)
      VALUES
        ($1, $2, 'session', now() + interval '1 hour')
    `,
    [sessionId, userId],
  );

  await db.query(
    `
      INSERT INTO
        mfa_enrollments (user_id, session_id, secret, expires_at)
      VALUES
        ($1, $2, $3, now() + interval '10 minutes')
    `,
    [userId, sessionId, encrypted],
  );

  await db.query(
    `
      INSERT INTO
        mfa_challenges (token_hash, user_id, expires_at)
      VALUES
        ('challenge', $1, now() + interval '5 minutes')
    `,
    [userId],
  );

  await db.query("INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,'code')", [userId]);
  expect(await verify(db)).toMatchObject({ mfa_accounts: 1 });
  await quarantine(db);

  expect(
    (await db.query('SELECT mfa_secret FROM users WHERE id=$1', [userId])).rows[0].mfa_secret,
  ).toEqual(encrypted);

  for (const table of ['mfa_enrollments', 'mfa_challenges', 'mfa_recovery_codes']) {
    expect((await db.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
  }

  expect(
    (await db.query('SELECT revoked_at FROM browser_sessions WHERE id=$1', [sessionId])).rows[0]
      .revoked_at,
  ).not.toBeNull();

  vi.stubEnv('KEEL_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  await expect(verify(db)).rejects.toThrow('decrypt');
});
