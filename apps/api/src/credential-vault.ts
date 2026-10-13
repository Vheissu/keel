import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src/index.js';

const envelope = z.object({
  version: z.literal(1),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

export class CredentialVault {
  private key: Buffer;

  constructor(
    encodedKey: string,
    private purpose: 'credentials' | 'deployment-secrets' | 'notifications' | 'mfa' = 'credentials',
  ) {
    this.key = Buffer.from(encodedKey, 'base64');

    if (this.key.length !== 32 || this.key.toString('base64') !== encodedKey) {
      const variable =
        purpose === 'deployment-secrets' ? 'KEEL_DEPLOYMENT_SECRET_KEY' : 'KEEL_CREDENTIAL_KEY';

      throw new Error(`${variable} must be a base64-encoded 32-byte key.`);
    }
  }

  encrypt(organisation: string, connection: string, value: unknown) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);

    cipher.setAAD(Buffer.from(`keel:${this.purpose}:v1:${organisation}:${connection}`));

    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);

    return {
      version: 1,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt<T>(organisation: string, connection: string, value: unknown): T {
    try {
      const encrypted = envelope.parse(value);
      const nonce = Buffer.from(encrypted.nonce, 'base64');
      const tag = Buffer.from(encrypted.tag, 'base64');

      // Reject truncated tags or nonces, which GCM would otherwise accept.
      if (nonce.length !== 12 || tag.length !== 16) {
        throw new Error('Invalid credential envelope.');
      }

      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 });

      decipher.setAAD(Buffer.from(`keel:${this.purpose}:v1:${organisation}:${connection}`));
      decipher.setAuthTag(tag);

      const bytes = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
        decipher.final(),
      ]);

      return JSON.parse(bytes.toString('utf8')) as T;
    } catch {
      throw new DomainError(
        'CREDENTIAL_UNAVAILABLE',
        'The connection credentials could not be decrypted.',
        503,
      );
    }
  }

  fingerprint(value: string) {
    // A database-only attacker cannot test guesses for a low-entropy secret using request hashes.
    return createHmac('sha256', this.key)
      .update(`keel:${this.purpose}:request:v1:${value}`)
      .digest('hex');
  }
}

export function deploymentSecretVault(key = process.env.KEEL_DEPLOYMENT_SECRET_KEY) {
  return key ? new CredentialVault(key, 'deployment-secrets') : undefined;
}
