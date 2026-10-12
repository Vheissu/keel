import { database } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';

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
