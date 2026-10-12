import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import fastifyStatic from '@fastify/static';
import { database } from '../../../packages/database/src/index.js';
import { artifactStore, repositoryRoot } from './storage-config.js';
import { CredentialVault, deploymentSecretVault } from './credential-vault.js';
import { IntegrationService } from './integration-service.js';
import { ControlPlane } from './control-plane.js';
import { createApp } from './app.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Run npm run setup first.');
}

const db = database(process.env.DATABASE_URL);

const control = new ControlPlane(db, artifactStore(), deploymentSecretVault());

const vault = process.env.KEEL_CREDENTIAL_KEY
  ? new CredentialVault(process.env.KEEL_CREDENTIAL_KEY)
  : undefined;

const integrations = new IntegrationService(control, vault);

if (!!process.env.API_TLS_CERT !== !!process.env.API_TLS_KEY) {
  throw new Error('API_TLS_CERT and API_TLS_KEY must be configured together.');
}

const https = process.env.API_TLS_CERT
  ? {
      cert: await readFile(process.env.API_TLS_CERT),
      key: await readFile(process.env.API_TLS_KEY!),
      minVersion: 'TLSv1.3' as const,
    }
  : undefined;

const app = await createApp(control, true, integrations, https);

if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, {
    root: resolve(repositoryRoot, 'apps/web/dist'),
    wildcard: false,
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    }

    return reply.sendFile('index.html');
  });
}

app.addHook('onClose', () => db.end());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void app.close();
  });
}

await app.listen({ port: Number(process.env.PORT || 4040), host: process.env.HOST || '127.0.0.1' });
