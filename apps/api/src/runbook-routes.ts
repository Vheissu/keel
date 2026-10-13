import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseRunbook } from '../../../packages/deployment-schema/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { idempotentMutation } from './idempotent-mutation.js';
import {
  runbookInput,
  runbookVersionInput,
  runbookPlanInput,
  runbookAcknowledgement,
} from './runbooks.js';

export async function registerRunbookRoutes(api: FastifyInstance, control: ControlPlane) {
  const uuid = z.string().uuid();

  api.post('/runbooks/validate', async (req) => {
    const input = z.object({ process: z.unknown() }).strict().parse(req.body);

    return { process: parseRunbook(input.process) };
  });

  api.post('/runbooks', async (req) => {
    const input = runbookInput.parse(req.body);

    return idempotentMutation(control, req, `runbook:${JSON.stringify(input)}`, (tx) =>
      control.runbooks.create(tx, req.principal, input),
    );
  });

  api.post<{ Params: { id: string } }>('/runbooks/:id/versions', async (req) => {
    const id = uuid.parse(req.params.id);
    const input = runbookVersionInput.parse(req.body);

    return idempotentMutation(
      control,
      req,
      `runbook-version:${id}:${JSON.stringify(input)}`,
      (tx) => control.runbooks.publish(tx, req.principal, id, input),
    );
  });

  api.post('/runbook-plans', async (req) => {
    const input = runbookPlanInput.parse(req.body);

    return idempotentMutation(control, req, `runbook-review:${JSON.stringify(input)}`, (tx) =>
      control.runbooks.review(tx, req.principal, input),
    );
  });

  api.post<{ Params: { id: string } }>('/runbook-plans/:id/request', async (req) => {
    const id = uuid.parse(req.params.id);
    const input = runbookAcknowledgement.parse(req.body);

    return idempotentMutation(
      control,
      req,
      `runbook-request:${id}:${JSON.stringify(input)}`,
      (tx) => control.runbooks.request(tx, req.principal, id),
    );
  });

  api.get<{ Params: { id: string } }>('/runbook-runs/:id/secret-bindings', async (req) => {
    const id = uuid.parse(req.params.id);

    const exists = await control.db.query(
      'SELECT 1 FROM runbook_runs WHERE organisation_id=$1 AND id=$2',
      [req.principal.organisation_id, id],
    );

    if (!exists.rowCount) {
      throw new DomainError('NOT_FOUND', 'Runbook run not found.', 404);
    }

    return control.secrets.bindings(req.principal.organisation_id, id);
  });

  for (const action of ['approve', 'reject', 'cancel'] as const) {
    api.post<{ Params: { id: string } }>(`/runbook-runs/:id/${action}`, async (req) => {
      const id = uuid.parse(req.params.id);

      const input =
        action === 'approve'
          ? runbookAcknowledgement.parse(req.body)
          : z
              .object({})
              .strict()
              .parse(req.body ?? {});

      return idempotentMutation(
        control,
        req,
        `runbook-${action}:${id}:${JSON.stringify(input)}`,
        (tx) => control.transition(tx, req.principal, id, action, true),
        action === 'cancel' ? 'write' : 'approve',
      );
    });
  }
}
