import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  DomainError,
  requirePermission,
  type Principal,
} from '../../../packages/domain/src/index.js';
import { parseProcess } from '../../../packages/deployment-schema/src/index.js';
import { providers } from '../../../packages/integrations/src/index.js';
import {
  ControlPlane,
  projectInput,
  artifactInput,
  releaseInput,
  deploymentInput,
} from './control-plane.js';
import { sha256 } from './artifact-store.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export async function createApp(service: ControlPlane, logger = false) {
  const app = Fastify({
    logger: logger ? { redact: ['req.headers.authorization'] } : false,
    bodyLimit: 25 * 1024 * 1024,
    requestTimeout: 30000,
  });

  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  app.decorateRequest('principal');

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, req, reply) => {
    if (error instanceof DomainError) {
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message, request_id: req.id } });
    }

    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          request_id: req.id,
        },
      });
    }

    const conflict = error.code === '23505';

    if (!conflict && (!error.statusCode || error.statusCode >= 500)) {
      req.log.error(error);
    }

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'The request could not be completed.';

    if (conflict) {
      status = 409;
      code = 'CONFLICT';
      message = 'This record already exists, or the environment has an active deployment request.';
    } else if (error.statusCode && error.statusCode < 500) {
      status = error.statusCode;
      code = 'INVALID_REQUEST';
      message = error.message;
    }

    return reply.code(status).send({
      error: {
        code,
        message,
        request_id: req.id,
      },
    });
  });

  app.get('/health', async (_req, reply) => {
    try {
      await service.db.query('SELECT 1');

      return { status: 'ok', execution: 'not-configured' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req) => {
        const token = req.headers.authorization?.match(/^Bearer (\S{16,256})$/)?.[1];

        if (!token) {
          throw new DomainError('UNAUTHENTICATED', 'Enter a valid API token to connect.', 401);
        }

        req.principal = await service.authenticate(token);
        requirePermission(req.principal, 'read');
      });

      const mutation = async (
        req: FastifyRequest,
        work: Parameters<ControlPlane['mutate']>[3],
        permission: 'write' | 'approve' = 'write',
      ) => {
        requirePermission(req.principal, permission);

        const body = Buffer.isBuffer(req.body)
          ? sha256(req.body)
          : JSON.stringify(req.body ?? null);

        return service.mutate(
          req.principal,
          String(req.headers['idempotency-key'] ?? ''),
          sha256(`${req.method}:${req.url}:${body}`),
          work,
        );
      };

      api.get('/snapshot', async (req) => {
        const p = req.principal;
        const client = await service.db.connect();

        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

          const result: Record<string, unknown> = {
            principal: p,
            execution: 'not-configured',
            limit: 200,
          };

          result.organisation = (
            await client.query('SELECT * FROM organisations WHERE id=$1', [p.organisation_id])
          ).rows[0];

          const totals: Record<string, number> = {};

          for (const table of [
            'projects',
            'environments',
            'artifacts',
            'releases',
            'deployments',
            'audit_events',
          ]) {
            result[table === 'audit_events' ? 'audit' : table] = (
              await client.query(
                `SELECT * FROM ${table} WHERE organisation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200`,
                [p.organisation_id],
              )
            ).rows;

            totals[table] = Number(
              (
                await client.query(`SELECT count(*) FROM ${table} WHERE organisation_id=$1`, [
                  p.organisation_id,
                ])
              ).rows[0].count,
            );
          }

          result.totals = totals;

          result.awaiting_approval = Number(
            (
              await client.query(
                `
                  SELECT
                    count(*)
                  FROM
                    deployments
                  WHERE
                    organisation_id = $1
                    AND status = 'awaiting_approval'
                `,
                [p.organisation_id],
              )
            ).rows[0].count,
          );

          await client.query('COMMIT');

          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      });

      api.get('/providers', async () => ({ providers }));

      api.post('/processes/validate', async (req) => ({
        process: parseProcess(z.object({ process: z.unknown() }).strict().parse(req.body).process),
      }));

      api.post('/projects', async (req) => {
        const input = projectInput.parse(req.body);

        return mutation(req, (tx) => service.project(tx, req.principal, input));
      });

      api.post('/artifacts', async (req) => {
        const input = artifactInput.parse(req.query);

        if (!Buffer.isBuffer(req.body)) {
          throw new DomainError(
            'INVALID_ARTIFACT',
            'Send artifact bytes as application/octet-stream.',
          );
        }

        return mutation(req, (tx) =>
          service.artifact(tx, req.principal, input, req.body as Buffer),
        );
      });

      api.get<{ Params: { id: string } }>('/artifacts/:id/download', async (req, reply) => {
        const artifact = (
          await service.db.query('SELECT * FROM artifacts WHERE organisation_id=$1 AND id=$2', [
            req.principal.organisation_id,
            z.string().uuid().parse(req.params.id),
          ])
        ).rows[0];

        if (!artifact) {
          throw new DomainError('NOT_FOUND', 'Artifact not found.', 404);
        }

        const bytes = await service.store.get(req.principal.organisation_id, artifact.digest);

        return reply
          .header('Content-Disposition', `attachment; filename="${artifact.id}.bin"`)
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .type('application/octet-stream')
          .send(bytes);
      });

      api.post('/releases', async (req) => {
        const input = releaseInput.parse(req.body);

        return mutation(req, (tx) => service.release(tx, req.principal, input));
      });

      api.post('/deployments', async (req) => {
        const input = deploymentInput.parse(req.body);

        return mutation(req, (tx) => service.deploy(tx, req.principal, input));
      });

      for (const action of ['approve', 'reject', 'cancel'] as const) {
        api.post<{ Params: { id: string } }>(`/deployments/:id/${action}`, async (req) => {
          z.object({})
            .strict()
            .parse(req.body ?? {});

          return mutation(
            req,
            (tx) => service.transition(tx, req.principal, req.params.id, action),
            action === 'cancel' ? 'write' : 'approve',
          );
        });
      }
    },
    { prefix: '/api/v1' },
  );

  return app;
}
