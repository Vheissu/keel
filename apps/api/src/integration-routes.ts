import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../packages/domain/src/index.js';
import { bitbucketConnectionInput, bitbucketCredentialsInput } from './bitbucket-input.js';
import { sha256 } from './artifact-store.js';
import {
  adapterConnection,
  connectionColumns,
  connectionInput,
  credentialsInput,
  importColumns,
  importInput,
  IntegrationService,
} from './integration-service.js';

export async function registerIntegrationRoutes(api: FastifyInstance, service: IntegrationService) {
  const mutate = (req: FastifyRequest, work: Parameters<typeof service.control.mutate>[3]) => {
    requirePermission(req.principal, 'write');

    return service.control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`${req.method}:${req.url}:${JSON.stringify(req.body ?? null)}`),
      work,
    );
  };

  api.get('/integrations', async (req) => {
    const connections = await service.control.db.query(
      `
        SELECT
          ${connectionColumns}
        FROM
          provider_connections
        WHERE
          organisation_id = $1
        ORDER BY
          created_at DESC,
          id DESC
        LIMIT
          200
      `,
      [req.principal.organisation_id],
    );

    const imports = await service.control.db.query(
      `
        SELECT
          ${importColumns}
        FROM
          artifact_imports
        WHERE
          organisation_id = $1
        ORDER BY
          created_at DESC,
          id DESC
        LIMIT
          200
      `,
      [req.principal.organisation_id],
    );

    return {
      connections: connections.rows,
      imports: imports.rows,
      configured: service.configured,
      limit: 200,
    };
  });

  api.post('/integrations/github', async (req) => {
    const input = connectionInput.parse(req.body);

    return mutate(req, (tx) => service.create(tx, req.principal, input));
  });

  api.post('/integrations/bitbucket', async (req) => {
    const input = bitbucketConnectionInput.parse(req.body);

    return mutate(req, (tx) => service.createBitbucket(tx, req.principal, input));
  });

  api.post<{ Params: { id: string } }>('/integrations/:id/bitbucket-credentials', async (req) => {
    const input = bitbucketCredentialsInput.parse(req.body);

    return mutate(req, (tx) => service.rotateBitbucket(tx, req.principal, req.params.id, input));
  });

  api.post<{ Params: { id: string } }>('/integrations/:id/credentials', async (req) => {
    const input = credentialsInput.parse(req.body);

    return mutate(req, (tx) => service.rotate(tx, req.principal, req.params.id, input));
  });

  api.post<{ Params: { id: string } }>('/integrations/:id/state', async (req) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);

    return mutate(req, (tx) => service.setEnabled(tx, req.principal, req.params.id, input.enabled));
  });

  api.get<{ Params: { id: string } }>('/integrations/:id/pipelines', async (req) => {
    const connection = await service.load(req.principal.organisation_id, req.params.id);

    return {
      pipelines: await service.adapter(connection).listPipelines(adapterConnection(connection)),
    };
  });

  api.post<{ Params: { id: string } }>('/integrations/:id/imports', async (req) => {
    const input = importInput.parse(req.body);

    return mutate(req, (tx) => service.enqueue(tx, req.principal, req.params.id, input));
  });

  api.post<{ Params: { id: string } }>('/imports/:id/retry', async (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});

    return mutate(req, (tx) => service.retry(tx, req.principal, req.params.id));
  });
}
