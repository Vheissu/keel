import { readFile } from 'node:fs/promises';
import { database } from '../../../packages/database/src/index.js';
import { artifactStore } from '../../api/src/storage-config.js';
import { ControlPlane } from '../../api/src/control-plane.js';
import { ExecutionService } from '../../api/src/execution-service.js';
import { createGateway } from './gateway.js';

for (const name of ['DATABASE_URL', 'AGENT_TLS_CERT', 'AGENT_TLS_KEY', 'AGENT_TLS_CA']) {
  if (!process.env[name]) {
    throw new Error(`${name} is required.`);
  }
}

const db = database(process.env.DATABASE_URL!);
const execution = new ExecutionService(new ControlPlane(db, artifactStore(process.cwd())));

const app = await createGateway(execution, {
  cert: await readFile(process.env.AGENT_TLS_CERT!),
  key: await readFile(process.env.AGENT_TLS_KEY!),
  ca: await readFile(process.env.AGENT_TLS_CA!),
});

app.addHook('onClose', () => db.end());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void app.close();
  });
}

await app.listen({
  host: process.env.AGENT_HOST || '127.0.0.1',
  port: Number(process.env.AGENT_PORT || 4041),
});
