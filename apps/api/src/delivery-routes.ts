import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../packages/domain/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { sha256 } from './artifact-store.js';
import { policyInput } from './delivery-policy.js';
import { RollbackService, rollbackPlanInput, rollbackRequestInput } from './rollback-service.js';

export async function registerDeliveryRoutes(api: FastifyInstance, control: ControlPlane) {
  const rollback = new RollbackService(control);
  const uuid = z.string().uuid();

  api.get<{ Params: { id: string } }>('/releases/:id/promotion', async (req) => {
    const query = z.object({ environment_id: uuid }).strict().parse(req.query);

    return control.delivery.inspect(
      req.principal.organisation_id,
      uuid.parse(req.params.id),
      query.environment_id,
    );
  });

  api.post<{ Params: { id: string } }>('/environments/:id/promotion-policy', async (req) => {
    requirePermission(req.principal, 'approve');
    const id = uuid.parse(req.params.id);
    const input = policyInput.parse(req.body);

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`promotion-policy:${id}:${JSON.stringify(input)}`),
      (tx) => control.delivery.update(tx, req.principal, id, input),
    );
  });

  api.get<{ Params: { id: string } }>('/deployments/:id/rollback-candidates', async (req) => {
    const id = uuid.parse(req.params.id);
    const tx = await control.db.connect();

    try {
      await tx.query('BEGIN');
      const result = await rollback.candidates(tx, req.principal.organisation_id, id);

      await tx.query('COMMIT');

      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  });

  api.post('/rollback-plans', async (req) => {
    requirePermission(req.principal, 'write');
    const input = rollbackPlanInput.parse(req.body);

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`rollback-plan:${JSON.stringify(input)}`),
      (tx) => rollback.create(tx, req.principal, input),
    );
  });

  api.post<{ Params: { id: string } }>('/rollback-plans/:id/request', async (req) => {
    requirePermission(req.principal, 'write');
    const id = uuid.parse(req.params.id);
    const input = rollbackRequestInput.parse(req.body);

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`rollback-request:${id}:${JSON.stringify(input)}`),
      (tx) => rollback.request(tx, req.principal, id),
    );
  });
}
