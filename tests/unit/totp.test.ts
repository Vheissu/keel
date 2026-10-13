import { expect, it } from 'vitest';
import { base32, totp, verifyTotp } from '../../apps/api/src/totp.js';

const secret = Buffer.from('12345678901234567890').toString('base64');

it.each([
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
])('matches RFC 6238 SHA-1 at time %i', (seconds, code) => {
  expect(totp(secret, Math.floor(seconds / 30), 8)).toBe(code);
});

it('encodes an authenticator setup key and rejects replay, malformed and out-of-window codes', () => {
  expect(base32(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const now = 1234567890000;
  const step = Math.floor(now / 30000);
  const code = totp(secret, step);

  expect(verifyTotp(secret, code, null, now)).toBe(step);
  expect(verifyTotp(secret, code, step, now)).toBeNull();
  expect(verifyTotp(secret, totp(secret, step - 1), null, now)).toBe(step - 1);
  expect(verifyTotp(secret, totp(secret, step + 1), null, now)).toBe(step + 1);
  expect(verifyTotp(secret, totp(secret, step - 2), null, now)).toBeNull();
  expect(verifyTotp(secret, '12345', null, now)).toBeNull();
});
