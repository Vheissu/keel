import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();
const base64 = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');

/** A software authenticator that produces real P-256 signatures for protocol tests. */
export function passkeyAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);

  const key = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );

  function data(rpId: string, flags: number, counter: number) {
    const count = Buffer.alloc(4);

    count.writeUInt32BE(counter);

    return Buffer.concat([hash(rpId), Buffer.from([flags]), count]);
  }

  return {
    id: base64(id),
    registration(challenge: string, origin: string, flags = 0x45) {
      const length = Buffer.alloc(2);

      length.writeUInt16BE(id.length);

      const authData = Buffer.concat([
        data(new URL(origin).hostname, flags, 0),
        Buffer.alloc(16),
        length,
        id,
        key,
      ]);

      return {
        id: base64(id),
        rawId: base64(id),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64(
            JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
          ),
          attestationObject: base64(
            isoCBOR.encode(
              new Map<string, unknown>([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', authData],
              ]) as Parameters<typeof isoCBOR.encode>[0],
            ),
          ),
          transports: ['internal'],
        },
      };
    },
    assertion(
      challenge: string,
      origin: string,
      userId: string,
      counter = 1,
      flags = 5,
      rpId = new URL(origin).hostname,
    ) {
      const client = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
      );

      const authData = data(rpId, flags, counter);

      return {
        id: base64(id),
        rawId: base64(id),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64(client),
          authenticatorData: base64(authData),
          userHandle: base64(userId),
          signature: base64(sign('sha256', Buffer.concat([authData, hash(client)]), privateKey)),
        },
      };
    },
  };
}
