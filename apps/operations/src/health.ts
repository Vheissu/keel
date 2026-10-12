import { readFile, stat } from 'node:fs/promises';
import { request } from 'node:https';
import { connect } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { Connection } from '@temporalio/client';
import type { Database } from '../../../packages/database/src/index.js';
import { OperationError } from './operation-error.js';

export async function health(db: Database, service: string) {
  await db.query('SELECT 1');

  if (service === 'api') {
    const ca = await readFile(process.env.API_TLS_CA!);

    await new Promise<void>((resolve, reject) => {
      const req = request(
        'https://127.0.0.1:4040/health',
        { ca, servername: process.env.API_TLS_SERVER_NAME || 'localhost', timeout: 4000 },
        (res) => {
          res.resume();

          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new OperationError('API not ready.'));
          }
        },
      );

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new OperationError('API timed out.')));
      req.end();
    });
  } else if (service === 'agent-gateway') {
    const certificate = new X509Certificate(await readFile(process.env.AGENT_TLS_CERT!));

    if (
      Date.parse(certificate.validTo) <= Date.now() ||
      Date.parse(certificate.validFrom) > Date.now()
    ) {
      throw new OperationError('Gateway certificate is not valid.');
    }

    await new Promise<void>((resolve, reject) => {
      const socket = connect(4041, '127.0.0.1');

      socket.setTimeout(4000);

      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.on('error', reject);
      socket.on('timeout', () => socket.destroy(new OperationError('Gateway timed out.')));
    });
  } else if (['artifact-worker', 'workflow-worker', 'notification-worker'].includes(service)) {
    const file = await stat(process.env.KEEL_HEALTH_FILE!);

    if (Date.now() - file.mtimeMs > 300000) {
      throw new OperationError('Worker heartbeat is stale.');
    }

    if (service === 'workflow-worker') {
      const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });

      try {
        await connection.workflowService.getSystemInfo({});
      } finally {
        await connection.close();
      }
    }
  } else {
    throw new OperationError('Unknown service.');
  }
}
