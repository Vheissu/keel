import { database } from '../packages/database/src/index.js';
import { identityAdmin } from '../apps/operations/src/identity-admin.js';

if (!process.env.DATABASE_URL || !process.env.KEEL_PUBLIC_URL) {
  throw new Error('DATABASE_URL and KEEL_PUBLIC_URL are required.');
}

const db = database(process.env.DATABASE_URL);

try {
  console.log(
    JSON.stringify(
      await identityAdmin(db, process.argv.slice(2), process.env.KEEL_PUBLIC_URL),
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
