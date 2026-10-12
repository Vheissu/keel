import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';
import { migrate } from '../../packages/database/src/migrate.js';
import { fixture, testDatabaseUrl } from '../fixtures.js';

it('adds staging prerequisites within each existing workspace and preserves later policy edits', async () => {
  const schema = `policy_upgrade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: testDatabaseUrl });

  const db = new pg.Pool({
    connectionString: testDatabaseUrl,
    options: `-c search_path=${schema}`,
  });

  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await db.query('CREATE TABLE schema_migrations (name text PRIMARY KEY)');
    const folder = new URL('../../packages/database/migrations/', import.meta.url);

    for (const name of (await readdir(folder))
      .filter((name) => name.endsWith('.sql') && name < '006')
      .sort()) {
      await db.query(await readFile(new URL(name, folder), 'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }

    const first = await fixture(db);
    const second = await fixture(db);

    await migrate(db);

    for (const workspace of [first, second]) {
      const result = await db.query(
        `
          SELECT
            promotion_from_environment_id,
            policy_revision,
            requires_approval
          FROM
            environments
          WHERE
            id = $1
        `,
        [workspace.environments.production],
      );

      expect(result.rows[0]).toEqual({
        promotion_from_environment_id: workspace.environments.staging,
        policy_revision: 1,
        requires_approval: true,
      });
    }

    await db.query(
      `
        UPDATE environments
        SET
          promotion_from_environment_id = NULL,
          policy_revision = 2
        WHERE
          id = $1
      `,
      [first.environments.production],
    );

    await migrate(db);

    const preserved = await db.query(
      'SELECT promotion_from_environment_id, policy_revision FROM environments WHERE id=$1',
      [first.environments.production],
    );

    expect(preserved.rows[0]).toEqual({ promotion_from_environment_id: null, policy_revision: 2 });
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
