import { scopeCondition } from './environment-access.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ExecutionService,
  agentInput,
  targetInput,
  certificateInput,
} from './execution-service.js';
import { idempotentMutation } from './idempotent-mutation.js';

export async function registerExecutionRoutes(api: FastifyInstance, execution: ExecutionService) {
  api.get('/execution', async (req) => {
    const org = req.principal.organisation_id;

    const agents = await execution.control.db.query(
      `
        SELECT
          *
        FROM
          deployment_agents t
        WHERE
          organisation_id = $1
          AND ${scopeCondition('agents', '$2', '$3')}
        ORDER BY
          created_at DESC
        LIMIT
          200
      `,
      [org, req.principal.project_ids ?? null, req.principal.environment_ids ?? null],
    );

    const targets = await execution.control.db.query(
      `
        SELECT
          *
        FROM
          deployment_targets t
        WHERE
          organisation_id = $1
          AND ${scopeCondition('targets', '$2', '$3')}
        ORDER BY
          created_at DESC
        LIMIT
          200
      `,
      [org, req.principal.project_ids ?? null, req.principal.environment_ids ?? null],
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
          deployment_attempts t
        WHERE
          organisation_id = $1
          AND ${scopeCondition('attempts', '$2', '$3')}
        ORDER BY
          created_at DESC
        LIMIT
          200
      `,
      [org, req.principal.project_ids ?? null, req.principal.environment_ids ?? null],
    );

    return { agents: agents.rows, targets: targets.rows, attempts: attempts.rows };
  });

  api.post('/agents', async (req) => {
    const input = agentInput.parse(req.body);

    return idempotentMutation(execution.control, req, `agent:${JSON.stringify(input)}`, (tx) =>
      execution.registerAgent(tx, req.principal, input),
    );
  });

  api.post<{ Params: { id: string } }>('/agents/:id/state', async (req) => {
    const input = z
      .object({ state: z.enum(['active', 'draining', 'revoked']) })
      .strict()
      .parse(req.body);

    return idempotentMutation(
      execution.control,
      req,
      `agent:${req.params.id}:${input.state}`,
      (tx) => execution.agentState(tx, req.principal, req.params.id, input.state),
    );
  });

  api.post<{ Params: { id: string } }>('/agents/:id/certificate', async (req) => {
    const input = certificateInput.parse(req.body);

    return idempotentMutation(
      execution.control,
      req,
      `agent-certificate:${req.params.id}:${JSON.stringify(input)}`,
      (tx) => execution.replaceCertificate(tx, req.principal, req.params.id, input),
    );
  });

  api.post('/targets', async (req) => {
    const input = targetInput.parse(req.body);

    return idempotentMutation(execution.control, req, `target:${JSON.stringify(input)}`, (tx) =>
      execution.registerTarget(tx, req.principal, input),
    );
  });
}
