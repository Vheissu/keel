import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { DomainError } from '../../../packages/domain/src/index.js';
import { sha256, type ArtifactStore } from './artifact-store.js';

const maximumBytes = 25 * 1024 * 1024;

export class S3ArtifactStore implements ArtifactStore {
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}

  private key(organisation: string, digest: string) {
    if (!/^[a-f0-9-]{36}$/.test(organisation) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new DomainError('INVALID_BLOB', 'Invalid blob reference.');
    }

    return `${organisation}/${digest}`;
  }

  async put(organisation: string, digest: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > maximumBytes) {
      throw new DomainError(
        'INVALID_ARTIFACT_SIZE',
        'Artifacts must contain between 1 byte and 25 MiB.',
      );
    }

    if (sha256(bytes) !== digest) {
      throw new DomainError(
        'DIGEST_MISMATCH',
        'Artifact bytes do not match the supplied SHA-256 digest.',
      );
    }

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(organisation, digest),
          Body: bytes,
          IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
          ContentType: 'application/octet-stream',
        }),
      );
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;

      // Another publisher can win the conditional write; verify its bytes below.
      if (status !== 412) {
        throw new DomainError(
          'STORAGE_UNAVAILABLE',
          'Artifact storage is unavailable. Retry the import.',
          503,
        );
      }
    }

    await this.get(organisation, digest);
  }

  async get(organisation: string, digest: string) {
    const key = this.key(organisation, digest);

    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      const chunks: Buffer[] = [];
      let size = 0;

      const body = object.Body as Readable | undefined;

      if (!body || (object.ContentLength ?? 0) > maximumBytes) {
        body?.destroy();
        throw new DomainError(
          'ARTIFACT_CORRUPT',
          'The retained artifact has an invalid size.',
          409,
        );
      }

      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        size += chunk.length;

        if (size > maximumBytes) {
          throw new DomainError(
            'ARTIFACT_CORRUPT',
            'The retained artifact exceeds the size limit.',
            409,
          );
        }

        chunks.push(Buffer.from(chunk));
      }

      const bytes = Buffer.concat(chunks);

      if (sha256(bytes) !== digest) {
        throw new DomainError(
          'ARTIFACT_CORRUPT',
          'The retained artifact failed SHA-256 verification.',
          409,
        );
      }

      return bytes;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }

      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        throw new DomainError(
          'ARTIFACT_UNAVAILABLE',
          'The retained artifact is missing. Restore it before deploying.',
          409,
        );
      }

      throw new DomainError(
        'STORAGE_UNAVAILABLE',
        'Artifact storage is unavailable. Retry the request.',
        503,
      );
    }
  }
}
