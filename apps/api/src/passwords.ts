import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src/index.js';

export const passwordInput = z
  .string()
  .min(15)
  .max(128)
  .refine((value) => Buffer.byteLength(value) <= 512, 'Password is too long.');

let hashing = 0;

async function derive(password: string, salt: string): Promise<Buffer> {
  // Bound expensive work; never let login attempts exhaust the process memory.
  if (hashing >= 2) {
    throw new DomainError('AUTH_BUSY', 'Sign-in is busy. Try again shortly.', 429);
  }

  hashing++;

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  } finally {
    hashing--;
  }
}

export async function hashPassword(password: string) {
  passwordInput.parse(password);
  const salt = randomBytes(32).toString('hex');
  const key = await derive(password, salt);

  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string) {
  // Unknown emails do the same expensive work without disclosing whether an account exists.
  const [, salt, expected] = stored?.split('$') ?? [];
  const key = await derive(password, salt || '0'.repeat(64));
  const wanted = Buffer.from(expected || '0'.repeat(128), 'hex');

  return wanted.length === key.length && timingSafeEqual(key, wanted) && !!stored;
}
