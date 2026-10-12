import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { database, transaction, type Database } from './index.js';

export async function migrate(db: Database) {
  await transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('keel-migrations'))");

    await tx.query(
      `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `,
    );

    const folder = new URL('../migrations/', import.meta.url);

    for (const name of (await readdir(folder)).filter((n) => n.endsWith('.sql')).sort()) {
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) {
        continue;
      }

      await tx.query(await readFile(new URL(name, folder), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const db = database(process.env.DATABASE_URL);

  try {
    await migrate(db);
    console.log('Database migrations applied.');
  } finally {
    await db.end();
  }
}
