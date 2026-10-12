import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { database } from '../../../packages/database/src/index.js';
import { LocalArtifactStore } from './artifact-store.js';
import { ControlPlane } from './control-plane.js';
import { createApp } from './app.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Run npm run setup first.');
}

const db = database(process.env.DATABASE_URL);

// Resolve from the repository root in both workspace dev and compiled startup.
const root = process.env.INIT_CWD || process.cwd();
const store = new LocalArtifactStore(resolve(root, process.env.ARTIFACT_PATH || '.data/artifacts'));
const app = await createApp(new ControlPlane(db, store), true);

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
