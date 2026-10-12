import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, requirePermission } from '../../../packages/domain/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { sha256 } from './artifact-store.js';
import { secretCreateInput, secretRevokeInput, secretRotateInput } from './deployment-secrets.js';

export async function registerSecretRoutes(api: FastifyInstance, control: ControlPlane) {
  const uuid = z.string().uuid();

  api.get('/secrets', async (req, reply) => {
    const input = z.object({ project_id: uuid, environment_id: uuid }).strict().parse(req.query);

    reply.header('Cache-Control', 'no-store');

    return control.secrets.list(
      req.principal.organisation_id,
      input.project_id,
      input.environment_id,
    );
  });

  api.get<{ Params: { id: string } }>('/deployments/:id/secret-bindings', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    return control.secrets.bindings(req.principal.organisation_id, uuid.parse(req.params.id));
  });

  // Keep validation errors generic: untrusted object keys must not echo secret material.
  function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);

    if (!result.success) {
      throw new DomainError(
        'INVALID_SECRET_INPUT',
        'Use a valid scope, uppercase secret name, revision and single-line value of 1–8192 UTF-8 bytes.',
      );
    }

    return result.data;
  }

  api.post('/secrets', { bodyLimit: 65536 }, async (req, reply) => {
    requirePermission(req.principal, 'manage_secrets');
    const input = parse(secretCreateInput, req.body);

    reply.header('Cache-Control', 'no-store');

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      control.secrets.fingerprint(`create:${JSON.stringify(input)}`),
      (tx) => control.secrets.create(tx, req.principal, input),
    );
  });

  api.post<{ Params: { id: string } }>(
    '/secrets/:id/versions',
    { bodyLimit: 65536 },
    async (req, reply) => {
      requirePermission(req.principal, 'manage_secrets');
      const id = uuid.parse(req.params.id);
      const input = parse(secretRotateInput, req.body);

      reply.header('Cache-Control', 'no-store');

      return control.mutate(
        req.principal,
        String(req.headers['idempotency-key'] ?? ''),
        control.secrets.fingerprint(`rotate:${id}:${JSON.stringify(input)}`),
        (tx) => control.secrets.rotate(tx, req.principal, id, input),
      );
    },
  );

  api.post<{ Params: { id: string } }>('/secrets/:id/revoke', async (req, reply) => {
    requirePermission(req.principal, 'manage_secrets');
    const id = uuid.parse(req.params.id);
    const input = parse(secretRevokeInput, req.body);

    reply.header('Cache-Control', 'no-store');

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`revoke:${id}:${JSON.stringify(input)}`),
      (tx) => control.secrets.revoke(tx, req.principal, id, input.expected_revision),
    );
  });
}
