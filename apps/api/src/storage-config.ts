import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { LocalArtifactStore, type ArtifactStore } from './artifact-store.js';
import { S3ArtifactStore } from './s3-artifact-store.js';

// Sources (apps/*/src) and bundles (apps/*/dist) sit at the same depth, so every process
// resolves relative paths against the same checkout regardless of its working directory.
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function localArtifactStore() {
  return new LocalArtifactStore(
    resolve(repositoryRoot, process.env.ARTIFACT_PATH || '.data/artifacts'),
  );
}

export function artifactStore(): ArtifactStore {
  const driver = process.env.ARTIFACT_STORE || 'local';

  if (driver === 'local') {
    return localArtifactStore();
  }

  if (driver !== 's3' || !process.env.S3_BUCKET) {
    throw new Error('Set ARTIFACT_STORE to local or s3; S3 requires S3_BUCKET.');
  }

  const endpoint = process.env.S3_ENDPOINT;

  if (endpoint) {
    const url = new URL(endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error('S3_ENDPOINT requires HTTPS unless it uses loopback for local evaluation.');
    }
  }

  const client = new S3Client({
    endpoint,
    region: process.env.AWS_REGION || 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    maxAttempts: 3,
    requestHandler: { requestTimeout: 30000, connectionTimeout: 5000 },
  });

  return new S3ArtifactStore(client, process.env.S3_BUCKET);
}
