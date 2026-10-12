import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { S3ArtifactStore } from '../../apps/api/src/s3-artifact-store.js';
import { sha256 } from '../../apps/api/src/artifact-store.js';

const endpoint = process.env.TEST_S3_ENDPOINT;
const bucket = `keel-test-${randomUUID()}`;
const organisation = randomUUID();
const bytes = Buffer.from('retained S3 build output');
const digest = sha256(bytes);

const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'keel-local', secretAccessKey: 'keel-local-storage-only' },
});

const store = new S3ArtifactStore(client, bucket);

describe.skipIf(!endpoint)('S3-compatible artifact retention', () => {
  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));

    if (objects.Contents?.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
        }),
      );
    }

    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  it('retains identical concurrent writes without overwriting and scopes keys by organisation', async () => {
    await Promise.all(Array.from({ length: 3 }, () => store.put(organisation, digest, bytes)));
    expect(await store.get(organisation, digest)).toEqual(bytes);

    await expect(store.get(randomUUID(), digest)).rejects.toMatchObject({
      code: 'ARTIFACT_UNAVAILABLE',
    });

    await expect(store.put(organisation, digest, Buffer.from('different'))).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
    });
  });

  it('detects tampering and refuses to silently repair an existing corrupt object', async () => {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: `${organisation}/${digest}`, Body: 'tampered' }),
    );

    await expect(store.get(organisation, digest)).rejects.toMatchObject({
      code: 'ARTIFACT_CORRUPT',
    });

    await expect(store.put(organisation, digest, bytes)).rejects.toMatchObject({
      code: 'ARTIFACT_CORRUPT',
    });
  });
});
