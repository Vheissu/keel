import { database } from '../packages/database/src/index.js';
import { artifactStore, localArtifactStore } from '../apps/api/src/storage-config.js';

if (!process.env.DATABASE_URL || process.env.ARTIFACT_STORE !== 's3') {
  throw new Error('Set DATABASE_URL, ARTIFACT_STORE=s3, and the destination S3 configuration.');
}

const db = database(process.env.DATABASE_URL);
const local = localArtifactStore();
const destination = artifactStore();
let copied = 0;
let current: { organisation_id: string; digest: string } | undefined;

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
    current = artifact;
    const bytes = await local.get(artifact.organisation_id, artifact.digest);

    await destination.put(artifact.organisation_id, artifact.digest, bytes);
    copied++;
  }

  console.log(
    `Verified ${copied} retained blobs in S3. Local files and database records are unchanged.`,
  );
} catch (error) {
  const blob = current ? ` at ${current.organisation_id}/${current.digest}` : '';

  console.error(
    `Copy stopped after ${copied} verified blobs${blob}: ${(error as Error).message} Check storage configuration and source integrity before retrying.`,
  );

  process.exitCode = 1;
} finally {
  await db.end();
}
