import { resolve } from 'node:path';
import { database } from '../packages/database/src/index.js';
import { LocalArtifactStore } from '../apps/api/src/artifact-store.js';
import { artifactStore } from '../apps/api/src/storage-config.js';

if (!process.env.DATABASE_URL || process.env.ARTIFACT_STORE !== 's3') {
  throw new Error('Set DATABASE_URL, ARTIFACT_STORE=s3, and the destination S3 configuration.');
}

const root = process.cwd();
const db = database(process.env.DATABASE_URL);
const local = new LocalArtifactStore(resolve(root, process.env.ARTIFACT_PATH || '.data/artifacts'));
const destination = artifactStore(root);
let copied = 0;

try {
  const artifacts = await db.query<{ organisation_id: string; digest: string }>(
    `
      SELECT
        organisation_id,
        digest
      FROM
        artifacts
      UNION
      SELECT
        organisation_id,
        candidate_digest AS digest
      FROM
        artifact_imports
      WHERE
        candidate_digest IS NOT NULL
      ORDER BY
        organisation_id,
        digest
    `,
  );

  for (const artifact of artifacts.rows) {
    const bytes = await local.get(artifact.organisation_id, artifact.digest);

    await destination.put(artifact.organisation_id, artifact.digest, bytes);
    copied++;
  }

  console.log(
    `Verified ${copied} retained blobs in S3. Local files and database records are unchanged.`,
  );
} catch {
  console.error(
    `Copy stopped after ${copied} verified blobs. Check storage configuration and source integrity before retrying.`,
  );

  process.exitCode = 1;
} finally {
  await db.end();
}
