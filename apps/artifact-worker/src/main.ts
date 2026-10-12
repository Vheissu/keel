import { setTimeout } from 'node:timers/promises';
import { database } from '../../../packages/database/src/index.js';
import { ArtifactImportWorker } from '../../api/src/artifact-import-worker.js';
import { ControlPlane } from '../../api/src/control-plane.js';
import { CredentialVault } from '../../api/src/credential-vault.js';
import { IntegrationService } from '../../api/src/integration-service.js';
import { artifactStore } from '../../api/src/storage-config.js';

if (!process.env.DATABASE_URL || !process.env.KEEL_CREDENTIAL_KEY) {
  throw new Error('DATABASE_URL and KEEL_CREDENTIAL_KEY are required. Run npm run setup first.');
}

const root = process.env.INIT_CWD || process.cwd();
const db = database(process.env.DATABASE_URL);
const control = new ControlPlane(db, artifactStore(root));

const integrations = new IntegrationService(
  control,
  new CredentialVault(process.env.KEEL_CREDENTIAL_KEY),
);

const worker = new ArtifactImportWorker(integrations);
const shutdown = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown.abort());
}

console.log('Artifact import worker ready.');

try {
  while (!shutdown.signal.aborted) {
    try {
      if (await worker.runOnce()) {
        continue;
      }
    } catch {
      // Provider errors are persisted on imports. Infrastructure errors must not expose credentials.
      console.error('Artifact worker could not reach its queue. Retrying in five seconds.');
    }

    await setTimeout(5000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await db.end();
}
