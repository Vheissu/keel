import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { database } from '../../../packages/database/src/index.js';
import { artifactStore } from './storage-config.js';
import { CredentialVault } from './credential-vault.js';
import { IntegrationService } from './integration-service.js';
import { ControlPlane } from './control-plane.js';
import { createApp } from './app.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Run npm run setup first.');
}

const db = database(process.env.DATABASE_URL);

// Resolve from the repository root in both workspace dev and compiled startup.
const root = process.env.INIT_CWD || process.cwd();
const control = new ControlPlane(db, artifactStore(root));

const vault = process.env.KEEL_CREDENTIAL_KEY
  ? new CredentialVault(process.env.KEEL_CREDENTIAL_KEY)
  : undefined;

const integrations = new IntegrationService(control, vault);
const app = await createApp(control, true, integrations);

if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: resolve(root, 'apps/web/dist'), wildcard: false });

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
