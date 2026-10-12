import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, open, readFile, stat } from 'node:fs/promises';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('KEELBK01');

export async function readKey(file: string) {
  const encoded = (await readFile(file, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');

  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('Backup key must be a base64-encoded 32-byte key.');
  }

  return key;
}

export async function hashFile(file: string) {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

export async function encrypt(input: Readable, file: string, key: Buffer, name: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

  cipher.setAAD(Buffer.from(`keel-backup-v1:${name}`));
  const output = createWriteStream(file, { flags: 'wx', mode: 0o600 });

  output.write(Buffer.concat([magic, nonce]));
  await pipeline(input, cipher, output);
  await appendFile(file, cipher.getAuthTag());
}

export async function decrypt(file: string, key: Buffer, name: string, output: Writable) {
  const handle = await open(file, 'r');

  try {
    const size = (await handle.stat()).size;
    const header = Buffer.alloc(20);
    const tag = Buffer.alloc(16);

    if (size < 36) {
      throw new Error('Truncated backup.');
    }

    await handle.read(header, 0, 20, 0);
    await handle.read(tag, 0, 16, size - 16);

    if (!header.subarray(0, 8).equals(magic)) {
      throw new Error('Unsupported backup format.');
    }

    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(8), { authTagLength: 16 });

    cipher.setAAD(Buffer.from(`keel-backup-v1:${name}`));
    cipher.setAuthTag(tag);
    await pipeline(createReadStream(file, { start: 20, end: size - 17 }), cipher, output);
  } finally {
    await handle.close();
  }
}

export async function verifyEncrypted(file: string, key: Buffer, name: string) {
  await decrypt(
    file,
    key,
    name,
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  );
}

export async function readManifest(file: string, key: Buffer) {
  if ((await stat(file)).size > 65536) {
    throw new Error('Oversized backup manifest.');
  }

  const chunks: Buffer[] = [];

  await decrypt(
    file,
    key,
    'manifest',
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
  );

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
