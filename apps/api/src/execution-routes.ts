import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../packages/domain/src/index.js';
import {
  ExecutionService,
  agentInput,
  targetInput,
  certificateInput,
} from './execution-service.js';
import { sha256 } from './artifact-store.js';

export async function registerExecutionRoutes(api: FastifyInstance, execution: ExecutionService) {
  api.get('/execution', async (req) => {
    const org = req.principal.organisation_id;

    const agents = await execution.control.db.query(
      `
        SELECT
          *
        FROM
          deployment_agents
        WHERE
          organisation_id = $1
        ORDER BY
          created_at DESC
        LIMIT
          200
      `,
      [org],
    );

    const targets = await execution.control.db.query(
      `
        SELECT
          *
        FROM
          deployment_targets
        WHERE
          organisation_id = $1
        ORDER BY
          created_at DESC
        LIMIT
          200
      `,
      [org],
    );

    const attempts = await execution.control.db.query(
      `
        SELECT
          id,
          deployment_id,
          target_id,
          agent_id,
          state,
          fence,
          result_code,
          phase,
          phase_updated_at,
          lease_expires_at,
          created_at,
          updated_at
        FROM
          deployment_attempts
        WHERE
          organisation_id = $1
        ORDER BY
          created_at DESC
        LIMIT
          200
      `,
      [org],
    );

    return { agents: agents.rows, targets: targets.rows, attempts: attempts.rows };
  });

  api.post('/agents', async (req) => {
    requirePermission(req.principal, 'write');
    const input = agentInput.parse(req.body);

    return execution.control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`agent:${JSON.stringify(input)}`),
      (tx) => execution.registerAgent(tx, req.principal, input),
    );
  });

  api.post<{ Params: { id: string } }>('/agents/:id/state', async (req) => {
    requirePermission(req.principal, 'write');

    const input = z
      .object({ state: z.enum(['active', 'draining', 'revoked']) })
      .strict()
      .parse(req.body);

    return execution.control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`agent:${req.params.id}:${input.state}`),
      (tx) => execution.agentState(tx, req.principal, req.params.id, input.state),
    );
  });

  api.post<{ Params: { id: string } }>('/agents/:id/certificate', async (req) => {
    requirePermission(req.principal, 'write');
    const input = certificateInput.parse(req.body);

    return execution.control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`agent-certificate:${req.params.id}:${JSON.stringify(input)}`),
      (tx) => execution.replaceCertificate(tx, req.principal, req.params.id, input),
    );
  });

  api.post('/targets', async (req) => {
    requirePermission(req.principal, 'write');
    const input = targetInput.parse(req.body);

    return execution.control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`target:${JSON.stringify(input)}`),
      (tx) => execution.registerTarget(tx, req.principal, input),
    );
  });
}
