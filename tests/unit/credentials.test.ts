import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';

const key = randomBytes(32).toString('base64');

describe('encrypted provider credentials', () => {
  it('authenticates the organisation, connection, ciphertext and key', () => {
    const vault = new CredentialVault(key);
    const organisation = randomUUID();
    const connection = randomUUID();
    const secret = { token: 'private-provider-token', webhook_secret: 'private-webhook-secret' };
    const encrypted = vault.encrypt(organisation, connection, secret);

    expect(JSON.stringify(encrypted)).not.toContain(secret.token);
    expect(vault.decrypt(organisation, connection, encrypted)).toEqual(secret);

    expect(() => vault.decrypt(randomUUID(), connection, encrypted)).toThrow(
      'could not be decrypted',
    );

    expect(() => vault.decrypt(organisation, randomUUID(), encrypted)).toThrow(
      'could not be decrypted',
    );

    expect(() =>
      vault.decrypt(organisation, connection, {
        ...encrypted,
        tag: randomBytes(16).toString('base64'),
      }),
    ).toThrow('could not be decrypted');

    expect(() =>
      new CredentialVault(randomBytes(32).toString('base64')).decrypt(
        organisation,
        connection,
        encrypted,
      ),
    ).toThrow('could not be decrypted');

    expect(vault.encrypt(organisation, connection, secret).ciphertext).not.toBe(
      encrypted.ciphertext,
    );
  });

  it('rejects invalid master keys', () => {
    expect(() => new CredentialVault('short')).toThrow('32-byte key');
  });
});
