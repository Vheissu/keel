import { registerRunbookRoutes } from './runbook-routes.js';
import {
  enforceEnvironmentRequest,
  scopeCondition,
  redactEnvironmentEvidence,
} from './environment-access.js';
import { enforceProjectRequest } from './project-access.js';
import { Identity } from './identity.js';
import { registerAuthRoutes, registerIdentityRoutes } from './identity-routes.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerResourceReads } from './resource-reads.js';
import Fastify, { type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { ServerOptions } from 'node:https';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  readOnlySnapshot,
  transaction,
  type Transaction,
} from '../../../packages/database/src/index.js';
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
import { ExecutionService } from './execution-service.js';
import { registerExecutionRoutes } from './execution-routes.js';
import { registerDeliveryRoutes } from './delivery-routes.js';
import { registerSecretRoutes } from './secret-routes.js';
import { sha256 } from './artifact-store.js';
import { IntegrationService } from './integration-service.js';
import { registerIntegrationRoutes } from './integration-routes.js';
import { registerBitbucketPublishing } from './bitbucket-publishing.js';
import { registerGitHubWebhook } from './github-webhook.js';
import { idempotentMutation } from './idempotent-mutation.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export async function createApp(
  service: ControlPlane,
  logger: FastifyServerOptions['logger'] = false,
  integrations = new IntegrationService(service),
  https?: ServerOptions,
  publicOrigin = process.env.KEEL_PUBLIC_URL,
) {
  const identity = publicOrigin ? new Identity(service, publicOrigin) : undefined;

  const app = Fastify({
    ...(https ? { https } : {}),
    logger: logger
      ? {
          ...(typeof logger === 'object' ? logger : {}),
          serializers: {
            req: (req) => ({
              method: req.method,
              url: req.url?.split('?')[0],
              hostname: req.hostname,
              remoteAddress: req.ip,
            }),
          },
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        }
      : false,
    bodyLimit: 25 * 1024 * 1024,
    requestTimeout: 30000,
  });

  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  app.decorateRequest('principal');

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, req, reply) => {
    const secretRequest =
      req.routeOptions.url?.startsWith('/api/v1/secrets') ||
      req.routeOptions.url?.startsWith('/api/v1/notifications') ||
      req.routeOptions.url?.startsWith('/api/auth') ||
      req.routeOptions.url?.startsWith('/api/v1/identity');

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
      if (secretRequest) {
        req.log.error({ code: 'SECRET_OPERATION_FAILED' }, 'Secret operation failed.');
      } else {
        req.log.error(error);
      }
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
      message = secretRequest ? 'Invalid secret request.' : error.message;
    }

    return reply.code(status).send({
      error: {
        code,
        message,
        request_id: req.id,
      },
    });
  });

  await registerAuthRoutes(app, identity);
  await registerGitHubWebhook(app, integrations);
  await registerBitbucketPublishing(app, integrations);

  app.get('/health', async (_req, reply) => {
    try {
      await service.db.query('SELECT 1');

      return { status: 'ok', execution: 'agent-protocol-available' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req) => {
        const token = req.headers.authorization?.match(/^Bearer (\S{16,256})$/)?.[1];

        if (req.headers.authorization) {
          if (!token) {
            throw new DomainError('UNAUTHENTICATED', 'Invalid API token.', 401);
          }

          req.principal = await service.authenticate(token);

          if (identity && !req.principal.user_id) {
            throw new DomainError(
              'UNAUTHENTICATED',
              'Use a managed API token for this workspace.',
              401,
            );
          }

          if (
            req.headers['x-workspace-id'] &&
            req.headers['x-workspace-id'] !== req.principal.organisation_id
          ) {
            throw new DomainError('FORBIDDEN', 'This token belongs to another workspace.', 403);
          }
        } else if (identity) {
          req.principal = await identity.principal(req);
        } else {
          throw new DomainError('UNAUTHENTICATED', 'Enter a valid API token to connect.', 401);
        }

        requirePermission(req.principal, 'read');
      });

      api.addHook('preHandler', async (req) => enforceProjectRequest(service.db, req));
      api.addHook('preHandler', async (req) => enforceEnvironmentRequest(service.db, req));

      api.addHook('preSerialization', async (req, _reply, payload) =>
        req.principal?.environment_ids
          ? redactEnvironmentEvidence(payload, req.principal.environment_ids)
          : payload,
      );

      const mutation = <T>(
        req: FastifyRequest,
        work: (tx: Transaction) => Promise<T>,
        permission: 'write' | 'approve' = 'write',
      ) => {
        const body = Buffer.isBuffer(req.body)
          ? sha256(req.body)
          : JSON.stringify(req.body ?? null);

        return idempotentMutation(
          service,
          req,
          `${req.method}:${req.url}:${body}`,
          work,
          permission,
        );
      };

      api.get('/snapshot', async (req) => {
        const p = req.principal;

        return transaction(
          service.db,
          async (tx) => {
            const result: Record<string, unknown> = {
              principal: p,
              execution: 'agent-protocol-available',
              limit: 200,
              integrations_configured: integrations.configured,
            };

            result.organisation = (
              await tx.query('SELECT * FROM organisations WHERE id=$1', [p.organisation_id])
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
              const condition = ` AND ${scopeCondition(table, '$2', '$3')}${table === 'deployments' ? " AND t.kind <> 'runbook'" : ''}`;
              const values = [p.organisation_id, p.project_ids ?? null, p.environment_ids ?? null];

              result[table === 'audit_events' ? 'audit' : table] = (
                await tx.query(
                  `
                    SELECT
                      *
                    FROM
                      ${table} t
                    WHERE
                      organisation_id = $1 ${condition}
                    ORDER BY
                      created_at DESC,
                      id DESC
                    LIMIT
                      200
                  `,
                  values,
                )
              ).rows;

              totals[table] = Number(
                (
                  await tx.query(
                    `SELECT count(*) FROM ${table} t WHERE organisation_id=$1 ${condition}`,
                    values,
                  )
                ).rows[0].count,
              );
            }

            result.environment_states = (
              await tx.query(
                `
                  SELECT DISTINCT
                    ON (d.project_id, d.environment_id) d.project_id,
                    e.slug AS environment_slug,
                    r.version AS release_version,
                    d.status
                  FROM
                    deployments d
                    JOIN environments e ON e.organisation_id = d.organisation_id
                    AND e.id = d.environment_id
                    JOIN releases r ON r.organisation_id = d.organisation_id
                    AND r.id = d.release_id
                  WHERE
                    d.organisation_id = $1
                    AND d.project_id = ANY ($2::UUID[])
                    AND ($3::uuid[] IS NULL OR d.environment_id=ANY($3::uuid[]))
                  ORDER BY
                    d.project_id,
                    d.environment_id,
                    d.created_at DESC,
                    d.id DESC
                `,
                [
                  p.organisation_id,
                  (result.projects as { id: string }[]).map((project) => project.id),
                  p.environment_ids ?? null,
                ],
              )
            ).rows;

            result.totals = totals;

            result.awaiting_approval = Number(
              (
                await tx.query(
                  `
                    SELECT
                      count(*)
                    FROM
                      deployments
                    WHERE
                      organisation_id = $1
                      AND status = 'awaiting_approval'
                      AND kind <> 'runbook'
                      AND ($2::uuid[] IS NULL OR project_id=ANY($2::uuid[]))
                      AND ($3::uuid[] IS NULL OR environment_id=ANY($3::uuid[]))
                  `,
                  [p.organisation_id, p.project_ids ?? null, p.environment_ids ?? null],
                )
              ).rows[0].count,
            );

            return result;
          },
          readOnlySnapshot,
        );
      });

      api.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
      });

      await registerIdentityRoutes(api, identity);
      await registerResourceReads(api, service.db);
      await registerIntegrationRoutes(api, integrations);
      await registerExecutionRoutes(api, new ExecutionService(service));
      await registerDeliveryRoutes(api, service);
      await registerRunbookRoutes(api, service);
      await registerSecretRoutes(api, service);
      await registerNotificationRoutes(api, service);

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
