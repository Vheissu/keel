import { resolve } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { Worker, NativeConnection } from '@temporalio/worker';
import { database } from '../../../packages/database/src/index.js';
import { artifactStore } from '../../api/src/storage-config.js';
import { ControlPlane } from '../../api/src/control-plane.js';
import { ExecutionService } from '../../api/src/execution-service.js';
import { dispatchOutbox } from './dispatcher.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.');
}

const address = process.env.TEMPORAL_ADDRESS || '127.0.0.1:7233';
const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'keel-deployments';
const db = database(process.env.DATABASE_URL);
const execution = new ExecutionService(new ControlPlane(db, artifactStore()));
const connection = await Connection.connect({ address });
const native = await NativeConnection.connect({ address });
const client = new Client({ connection, namespace });

const worker = await Worker.create({
  connection: native,
  namespace,
  taskQueue,
  workflowBundle: { codePath: resolve('apps/workflow-worker/dist/workflows.cjs') },
  activities: { tick: execution.tick.bind(execution) },
});

let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    worker.shutdown();
  });
}

const dispatch = async () => {
  while (!stopping) {
    try {
      await dispatchOutbox(db, client, taskQueue);
    } catch {
      console.error('Deployment outbox delivery failed; it will retry.');
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

try {
  await Promise.all([worker.run(), dispatch()]);
} finally {
  stopping = true;
  await native.close();
  await connection.close();
  await db.end();
}
