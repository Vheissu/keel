import { createHmac } from 'node:crypto';

// Independent authenticator implementation used by browser and packaged recovery tests.
export function authenticatorCode(setupKey: string, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  const bits = [...setupKey]
    .map((character) => alphabet.indexOf(character).toString(2).padStart(5, '0'))
    .join('');

  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const hash = createHmac('sha1', bytes).update(counter).digest();

  return String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
