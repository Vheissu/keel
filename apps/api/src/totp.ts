import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let result = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits) {
    result += alphabet[(value << (5 - bits)) & 31];
  }

  return result;
}

export const newTotpSecret = () => randomBytes(20).toString('base64');

export function totp(secret: string, step = Math.floor(Date.now() / 30000), digits = 6) {
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', Buffer.from(secret, 'base64')).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = digest.readUInt32BE(offset) & 0x7fffffff;

  return String(number % 10 ** digits).padStart(digits, '0');
}

export function verifyTotp(
  secret: string,
  code: string,
  lastStep: number | null,
  now = Date.now(),
) {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const current = Math.floor(now / 30000);

  for (const step of [current, current - 1, current + 1]) {
    if (
      step > (lastStep ?? -1) &&
      timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))
    ) {
      return step;
    }
  }

  return null;
}
