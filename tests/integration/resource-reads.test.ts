import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { transaction } from '../../packages/database/src/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrate } from '../../packages/database/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore } from '../../apps/api/src/artifact-store.js';
import { fixture, testDatabaseUrl } from '../fixtures.js';

const schema = `reads_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let app: FastifyInstance;
let root: string;
let f: Awaited<ReturnType<typeof fixture>>;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-reads-'));
  app = await createApp(new ControlPlane(db, new LocalArtifactStore(root)));
});

beforeEach(async () => {
  f = await fixture(db);
});

afterAll(async () => {
  await app.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

function get(path: string, token = f.reader.token) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/resources/${path}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function seed(count = 237) {
  // Repeated timestamps exercise UUID tie breaking; microseconds must survive the cursor round trip.
  await db.query(
    `
      INSERT INTO
        projects (id, organisation_id, name, slug, created_at)
      SELECT
        gen_random_uuid(),
        $1,
        'Project ' || n,
        'project-' || n,
        '2026-01-01T00:00:00Z'::timestamptz + ((n / 3) * interval '1 microsecond')
      FROM
        generate_series(1, $2::integer) n
    `,
    [f.org, count],
  );

  return (
    await db.query(
      'SELECT id FROM projects WHERE organisation_id=$1 ORDER BY created_at DESC, id DESC',
      [f.org],
    )
  ).rows.map((row) => row.id);
}

it('walks every row once past 200, returns to the previous page and excludes newer inserts', async () => {
  const expected = await seed();
  const firstResponse = await get('projects?limit=25');

  expect(firstResponse.statusCode).toBe(200);
  expect(firstResponse.headers['cache-control']).toBe('no-store');
  const first = firstResponse.json();

  expect(first.total).toBe(237);
  expect(first.previous_cursor).toBeNull();
  const seen = first.items.map((row: { id: string }) => row.id);

  await db.query(
    `
      INSERT INTO
        projects (id, organisation_id, name, slug)
      VALUES
        ($1, $2, 'New arrival', 'new-arrival')
    `,
    [randomUUID(), f.org],
  );

  let next = first.next_cursor;
  let pages = 1;

  while (next) {
    const response = await get(`projects?limit=25&cursor=${next}`);

    expect(response.statusCode).toBe(200);
    const page = response.json();

    expect(page.total).toBe(238);
    expect(page.items.length).toBeLessThanOrEqual(25);

    if (pages === 1) {
      const previous = (await get(`projects?limit=25&cursor=${page.previous_cursor}`)).json();

      expect(previous.items).toEqual(first.items);
      expect(previous.previous_cursor).toBeNull();
    }

    seen.push(...page.items.map((row: { id: string }) => row.id));
    next = page.next_cursor;
    pages++;
    expect(pages).toBeLessThan(20);
  }

  expect(seen).toEqual(expected);
  expect(pages).toBe(10);
  expect((await get('projects?limit=100')).json().items).toHaveLength(100);
});

it('enforces organisation, resource and filter scope, authentication and strict bounds', async () => {
  await seed(30);
  const page = (await get('projects')).json();
  const other = await fixture(db);

  expect((await get('projects', other.reader.token)).json()).toMatchObject({ items: [], total: 0 });
  expect((await get(`projects/${page.items[0].id}`, other.reader.token)).statusCode).toBe(404);
  expect((await get(`projects/${page.items[0].id}`)).json().id).toBe(page.items[0].id);

  for (const path of [
    'projects?limit=0',
    'projects?limit=101',
    'projects?limit=1.5',
    'projects?limit=-1',
    'projects?limit=1&limit=2',
    'projects?cursor=garbage',
    'projects?unknown=true',
    `projects?project_id=${randomUUID()}`,
    'projects?project_id=invalid',
    `projects?q=changed&cursor=${page.next_cursor}`,
    `environments?cursor=${page.next_cursor}`,
    'secrets',
    `secrets?project_id=${randomUUID()}`,
  ]) {
    expect((await get(path)).statusCode, path).toBe(400);
  }

  expect((await get(`projects?cursor=${page.next_cursor}`, other.reader.token)).statusCode).toBe(
    400,
  );

  expect((await get('__proto__')).statusCode).toBe(404);
  expect((await get('projects', 'invalid')).statusCode).toBe(401);
});

it('searches the complete collection with literal wildcard characters', async () => {
  await seed();

  await db.query(
    `
      UPDATE projects
      SET
        name = 'Literal 50%_value'
      WHERE
        organisation_id = $1
        AND slug = 'project-1'
    `,
    [f.org],
  );

  const result = (await get(`projects?q=${encodeURIComponent('50%_')}`)).json();

  expect(result.total).toBe(1);
  expect(result.items[0].slug).toBe('project-1');
  expect((await get(`projects?q=${encodeURIComponent("' OR true --")}`)).json().total).toBe(0);
});

it('serves every registered resource through the read permission and omits private agent material', async () => {
  const project = (await seed(1))[0];

  await db.query(
    `
      INSERT INTO
        deployment_agents (
          id,
          organisation_id,
          name,
          certificate_fingerprint
        )
      VALUES
        ($1, $2, 'Private agent', $3)
    `,
    [randomUUID(), f.org, 'a'.repeat(64)],
  );

  for (const resource of [
    'projects',
    'environments',
    'artifacts',
    'releases',
    'deployments',
    'audit',
    'agents',
    'targets',
    'attempts',
    'connections',
    'imports',
    `secrets?project_id=${project}&environment_id=${f.environments.staging}`,
  ]) {
    const response = await get(resource);

    expect(response.statusCode, `${resource}: ${response.body}`).toBe(200);
    expect(response.json()).toMatchObject({ limit: 25 });
  }

  const agent = (await get('agents')).json().items[0];

  expect(Object.keys(agent).sort()).toEqual(['created_at', 'id', 'last_seen_at', 'name', 'state']);
  expect((await get(`agents/${agent.id}`)).json()).toEqual(agent);
});

it('joins older related records and keeps overview state outside the snapshot deployment window', async () => {
  await seed();

  const oldProject = (
    await db.query("SELECT id FROM projects WHERE organisation_id=$1 AND slug='project-1'", [f.org])
  ).rows[0].id;

  const artifact = randomUUID();
  const release = randomUUID();

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
        ($1, $2, $3, 'build', '1', $4, 1, '{}')
    `,
    [artifact, f.org, oldProject, 'a'.repeat(64)],
  );

  await db.query(
    `
      INSERT INTO
        releases (
          id,
          organisation_id,
          project_id,
          artifact_id,
          version,
          manifest
        )
      VALUES
        ($1, $2, $3, $4, '1', '{}')
    `,
    [release, f.org, oldProject, artifact],
  );

  const row = (await get(`artifacts?project_id=${oldProject}`)).json().items[0];

  expect(row).toMatchObject({ id: artifact, project_name: 'Project 1' });
  expect((await get('artifacts?q=Project%201')).json().items).toHaveLength(1);
  expect((await get(`releases/${release}`)).json()).toMatchObject({ project_name: 'Project 1' });
  // Bring the project into the overview, but put its production request outside the latest 200 requests.
  await db.query('UPDATE projects SET created_at=now() WHERE id=$1', [oldProject]);

  await db.query(
    `
      INSERT INTO
        deployments (
          id,
          organisation_id,
          project_id,
          release_id,
          environment_id,
          status,
          requested_by,
          created_at
        )
      SELECT
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        'cancelled',
        $5,
        '2026-01-01'::timestamptz + n * interval '1 second'
      FROM
        generate_series(1, 205) n
    `,
    [f.org, oldProject, release, f.environments.staging, f.operator.id],
  );

  await db.query(
    `
      INSERT INTO
        deployments (
          id,
          organisation_id,
          project_id,
          release_id,
          environment_id,
          status,
          requested_by,
          created_at
        )
      VALUES
        ($1, $2, $3, $4, $5, 'cancelled', $6, '2025-01-01')
    `,
    [randomUUID(), f.org, oldProject, release, f.environments.production, f.operator.id],
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/snapshot',
    headers: { authorization: `Bearer ${f.reader.token}` },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().deployments).toHaveLength(200);

  expect(response.json().environment_states).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        project_id: oldProject,
        environment_slug: 'production',
        release_version: '1',
        status: 'cancelled',
      }),
    ]),
  );

  expect(
    (await get(`deployments?environment_id=${f.environments.production}`)).json().items[0],
  ).toMatchObject({
    project_name: 'Project 1',
    environment_name: 'Production',
    release_version: '1',
  });
});

it('returns only metadata for credentials, imports and scoped secrets in lists and lookups', async () => {
  const project = (await seed(1))[0];
  const connection = randomUUID();
  const imported = randomUUID();
  const secret = randomUUID();
  const lease = randomUUID();

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
          'Builds',
          'owner/repo',
          '1',
          '2',
          'main',
          'build',
          '{"private":"credential-ciphertext"}'
        )
    `,
    [connection, f.org, project, f.operator.id],
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
          status,
          lease_token,
          lease_expires_at
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          '123',
          1,
          'processing',
          $6,
          now() + interval '1 minute'
        )
    `,
    [imported, f.org, project, connection, f.operator.id, lease],
  );

  await transaction(db, async (tx) => {
    await tx.query(
      `
        INSERT INTO
          deployment_secrets (
            id,
            organisation_id,
            project_id,
            environment_id,
            name
          )
        VALUES
          ($1, $2, $3, $4, 'PASSWORD')
      `,
      [secret, f.org, project, f.environments.staging],
    );

    await tx.query(
      `
        INSERT INTO
          deployment_secret_versions (
            organisation_id,
            project_id,
            environment_id,
            secret_id,
            version,
            encrypted_value,
            created_by
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4,
            1,
            '{"private":"secret-ciphertext"}',
            $5
          )
      `,
      [f.org, project, f.environments.staging, secret, f.operator.id],
    );
  });

  for (const [resource, id, filters] of [
    ['connections', connection, `project_id=${project}`],
    ['imports', imported, `connection_id=${connection}&status=processing`],
    ['secrets', secret, `project_id=${project}&environment_id=${f.environments.staging}`],
  ]) {
    const response = await get(`${resource}?${filters}`);

    expect(response.statusCode, response.body).toBe(200);
    const record = response.json().items[0];

    expect(record.id).toBe(id);
    expect((await get(`${resource}/${id}`)).json()).toEqual(record);

    expect(JSON.stringify(record)).not.toMatch(
      /ciphertext|credentials|encrypted_value|lease_token/,
    );

    expect(JSON.stringify(record)).not.toContain(lease);
  }

  expect(
    (await get(`secrets?project_id=${project}&environment_id=${f.environments.production}`)).json()
      .total,
  ).toBe(0);
});

it('lists filtered pages through the live CLI with reusable cursors', async () => {
  await seed(30);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  const run = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'apps/cli/src/main.ts', ...args],
      {
        env: { ...process.env, KEEL_URL: address, KEEL_TOKEN: f.reader.token },
      },
    );

    return JSON.parse(stdout);
  };

  const first = await run('list', 'projects', '--limit', '10', '--search', 'Project');

  expect(first.items).toHaveLength(10);

  const next = await run(
    'list',
    'projects',
    '--limit',
    '10',
    '--search',
    'Project',
    '--cursor',
    first.next_cursor,
  );

  expect(next.items).toHaveLength(10);
  expect(next.items[0].id).not.toBe(first.items[0].id);

  const previous = await run(
    'list',
    'projects',
    '--limit',
    '10',
    '--search',
    'Project',
    '--cursor',
    next.previous_cursor,
  );

  expect(previous.items).toEqual(first.items);
});
