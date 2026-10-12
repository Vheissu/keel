import { setTimeout } from 'node:timers/promises';
import { database } from '../../../packages/database/src/index.js';
import { NotificationWorker } from '../../api/src/notification-worker.js';
import { heartbeat } from '../../operations/src/heartbeat.js';

if (!process.env.DATABASE_URL || !process.env.KEEL_CREDENTIAL_KEY) {
  throw new Error('DATABASE_URL and KEEL_CREDENTIAL_KEY are required.');
}

const db = database(process.env.DATABASE_URL);
const worker = new NotificationWorker(db);
const shutdown = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown.abort());
}

console.log('Notification worker ready.');

try {
  while (!shutdown.signal.aborted) {
    try {
      const worked = await worker.runOnce();

      await heartbeat();

      if (worked) {
        continue;
      }
    } catch {
      console.error('Notification queue unavailable. Retrying in five seconds.');
    }

    await setTimeout(5000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await db.end();
}
