import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DomainError } from '../../../packages/domain/src/index.js';

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export interface ArtifactStore {
  put(organisation: string, digest: string, bytes: Buffer): Promise<void>;
  get(organisation: string, digest: string): Promise<Buffer>;
}

// Report filesystem failures (ENOSPC, EIO, EACCES) the same way the S3 store reports outages.
function storageUnavailable(cause: unknown) {
  const error = new DomainError(
    'STORAGE_UNAVAILABLE',
    'Artifact storage is unavailable. Retry the request.',
    503,
  );

  error.cause = cause;

  return error;
}

// Local evaluation adapter. Blobs are published atomically and never overwritten.
export class LocalArtifactStore implements ArtifactStore {
  constructor(private root: string) {
    this.root = resolve(root);
  }

  private path(organisation: string, digest: string) {
    if (!/^[a-f0-9-]{36}$/.test(organisation) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new DomainError('INVALID_BLOB', 'Invalid blob reference.');
    }

    return join(this.root, organisation, digest);
  }

  async put(organisation: string, digest: string, bytes: Buffer) {
    if (sha256(bytes) !== digest) {
      throw new DomainError(
        'DIGEST_MISMATCH',
        'Artifact bytes do not match the supplied SHA-256 digest.',
      );
    }

    const destination = this.path(organisation, digest);
    const temporary = `${destination}.${randomUUID()}.tmp`;

    try {
      await mkdir(join(this.root, organisation), { recursive: true, mode: 0o700 });
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });

      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    } catch (error) {
      throw storageUnavailable(error);
    } finally {
      await unlink(temporary).catch(() => {});
    }

    await this.get(organisation, digest);
  }

  async get(organisation: string, digest: string) {
    let bytes: Buffer;

    try {
      bytes = await readFile(this.path(organisation, digest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DomainError(
          'ARTIFACT_UNAVAILABLE',
          'The retained artifact is missing. Restore it before deploying.',
          409,
        );
      }

      throw storageUnavailable(error);
    }

    if (sha256(bytes) !== digest) {
      throw new DomainError(
        'ARTIFACT_CORRUPT',
        'The retained artifact failed SHA-256 verification.',
        409,
      );
    }

    return bytes;
  }
}
