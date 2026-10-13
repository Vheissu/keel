import Fastify from 'fastify';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

// A real HTTP issuer with signed ID tokens; it checks client authentication and PKCE.
export async function oidcProvider() {
  const app = Fastify();
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const foreignKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map<string, URLSearchParams>();

  const state = {
    email: 'owner@example.com',
    subject: 'subject-1',
    invalid: '' as
      '' | 'nonce' | 'issuer' | 'audience' | 'signature' | 'expired' | 'email' | 'auth_time',
    verified: true,
    tokenRequests: 0,
  };

  let origin = '';

  function authorize(url: string) {
    const params = new URL(url).searchParams;
    const code = randomUUID();

    codes.set(code, params);
    const callback = new URL(params.get('redirect_uri')!);

    callback.searchParams.set('code', code);
    callback.searchParams.set('state', params.get('state')!);

    return callback.href;
  }

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, new URLSearchParams(body as string)),
  );

  app.get('/authorize', async (req, reply) => reply.redirect(authorize(`${origin}${req.url}`)));

  app.get('/jwks', async () => ({
    keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }],
  }));

  app.post('/token', async (req, reply) => {
    state.tokenRequests++;
    const body = req.body as URLSearchParams;
    const params = codes.get(body.get('code') || '');

    codes.delete(body.get('code') || '');

    if (
      !params ||
      body.get('client_id') !== 'keel-test' ||
      body.get('client_secret') !== 'provider-secret' ||
      body.get('redirect_uri') !== params.get('redirect_uri') ||
      createHash('sha256')
        .update(body.get('code_verifier') || '')
        .digest('base64url') !== params.get('code_challenge')
    ) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }

    const now = Math.floor(Date.now() / 1000);

    const claims = {
      iss: state.invalid === 'issuer' ? 'https://wrong.example' : origin,
      sub: state.subject,
      aud: state.invalid === 'audience' ? 'different-client' : 'keel-test',
      exp: state.invalid === 'expired' ? now - 120 : now + 300,
      iat: now,
      auth_time: state.invalid === 'auth_time' ? now - 3600 : now,
      nonce: state.invalid === 'nonce' ? 'wrong-nonce' : params.get('nonce'),
      email: state.invalid === 'email' ? 'someone-else@example.com' : state.email,
      email_verified: state.verified,
    };

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

    const signature = sign(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      state.invalid === 'signature' ? foreignKey.privateKey : key.privateKey,
    ).toString('base64url');

    return {
      access_token: 'unused-access-token',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: `${header}.${payload}.${signature}`,
    };
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const config = {
    name: 'Test identity provider',
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    jwks_uri: `${origin}/jwks`,
    client_id: 'keel-test',
    client_secret: 'provider-secret',
  };

  return { state, config, authorize, close: () => app.close() };
}
