import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { TLSSocket } from 'node:tls';
import type { ServerOptions } from 'node:https';
import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src/index.js';
import {
  ExecutionService,
  leaseInput,
  resultInput,
  progressInput,
  type AgentIdentity,
} from '../../api/src/execution-service.js';

export async function createGateway(execution: ExecutionService, tls: ServerOptions) {
  // Certificates are verified by Node TLS and matched to a registered fingerprint.
  // Never accept identity from proxy headers or expose these routes over plain HTTP.
  const app = Fastify({
    https: { ...tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
    bodyLimit: 4096,
    requestTimeout: 30000,
  });

  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  const identities = new WeakMap<object, AgentIdentity>();

  app.addHook('onRequest', async (req) => {
    const socket = req.raw.socket as TLSSocket;
    const certificate = socket.getPeerCertificate();

    if (!socket.authorized || !certificate.fingerprint256) {
      throw new DomainError(
        'AGENT_UNAUTHENTICATED',
        'A trusted client certificate is required.',
        401,
      );
    }

    identities.set(
      req,
      await execution.authenticate(certificate.fingerprint256.replaceAll(':', '').toLowerCase()),
    );
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }

    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    }

    return reply.code(500).send({ error: { code: 'GATEWAY_ERROR' } });
  });

  app.post('/agent/v1/poll', async (req) => {
    z.object({}).strict().parse(req.body);

    return { job: await execution.claim(identities.get(req)!) };
  });

  app.post('/agent/v1/heartbeat', async (req) =>
    execution.heartbeat(identities.get(req)!, leaseInput.parse(req.body)),
  );

  app.post('/agent/v1/progress', async (req) =>
    execution.progress(identities.get(req)!, progressInput.parse(req.body)),
  );

  app.post('/agent/v1/result', async (req) =>
    execution.complete(identities.get(req)!, resultInput.parse(req.body)),
  );

  app.post('/agent/v1/artifact', async (req, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .type('application/octet-stream')
      .send(await execution.download(identities.get(req)!, leaseInput.parse(req.body))),
  );

  return app;
}
