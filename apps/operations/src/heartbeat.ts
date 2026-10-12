import { writeFile } from 'node:fs/promises';

export async function heartbeat() {
  if (process.env.KEEL_HEALTH_FILE) {
    await writeFile(process.env.KEEL_HEALTH_FILE, String(Date.now()), { mode: 0o600 });
  }
}
