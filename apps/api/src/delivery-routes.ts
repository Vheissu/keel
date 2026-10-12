import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transaction } from '../../../packages/database/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { idempotentMutation } from './idempotent-mutation.js';
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
    const id = uuid.parse(req.params.id);
    const input = policyInput.parse(req.body);

    return idempotentMutation(
      control,
      req,
      `promotion-policy:${id}:${JSON.stringify(input)}`,
      (tx) => control.delivery.update(tx, req.principal, id, input),
      'approve',
    );
  });

  api.get<{ Params: { id: string } }>('/deployments/:id/rollback-candidates', async (req) => {
    const id = uuid.parse(req.params.id);

    const query = z
      .object({
        cursor: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .refine((value) => value.length < 19 || value <= '9223372036854775807')
          .optional(),
      })
      .strict()
      .parse(req.query);

    return transaction(control.db, (tx) =>
      rollback.candidates(tx, req.principal.organisation_id, id, query.cursor ?? null),
    );
  });

  api.post('/rollback-plans', async (req) => {
    const input = rollbackPlanInput.parse(req.body);

    return idempotentMutation(control, req, `rollback-plan:${JSON.stringify(input)}`, (tx) =>
      rollback.create(tx, req.principal, input),
    );
  });

  api.post<{ Params: { id: string } }>('/rollback-plans/:id/request', async (req) => {
    const id = uuid.parse(req.params.id);
    const input = rollbackRequestInput.parse(req.body);

    return idempotentMutation(
      control,
      req,
      `rollback-request:${id}:${JSON.stringify(input)}`,
      (tx) => rollback.request(tx, req.principal, id),
    );
  });
}
