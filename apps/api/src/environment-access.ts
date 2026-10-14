import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { projectCondition } from './project-access.js';

// Projects, artifacts and immutable release manifests are shared inputs to deployments.
// Integrations and audit history are workspace data and remain hidden from environment tokens.
export function environmentCondition(resource: string, parameter: string, alias = 't'): string {
  const direct: Record<string, string> = {
    environments: 'id',
    deployments: 'environment_id',
    runbooks: 'environment_id',
    'runbook-versions': 'environment_id',
    'runbook-plans': 'environment_id',
    'runbook-runs': 'environment_id',
    'runbook-schedules': 'environment_id',
    targets: 'environment_id',
    secrets: 'environment_id',
    'notification-endpoints': 'environment_id',
  };

  if (Object.hasOwn(direct, resource)) {
    return `${alias}.${direct[resource]} = ANY(${parameter}::uuid[])`;
  }

  const deployment = (id: string) => `EXISTS (
    SELECT 1 FROM deployments scope_environment_deployment
    WHERE scope_environment_deployment.organisation_id = ${alias}.organisation_id
      AND scope_environment_deployment.id = ${id}
      AND scope_environment_deployment.environment_id = ANY(${parameter}::uuid[])
  )`;

  switch (resource) {
    case 'projects':
    case 'artifacts':
    case 'releases':
      return `${parameter}::uuid[] IS NOT NULL`;
    case 'attempts':
      return deployment(`${alias}.deployment_id`);
    case 'notification-deliveries':
      return `${deployment(`${alias}.deployment_id`)} AND EXISTS (
        SELECT 1 FROM notification_endpoints scope_environment_endpoint
        WHERE scope_environment_endpoint.organisation_id = ${alias}.organisation_id
          AND scope_environment_endpoint.id = ${alias}.endpoint_id
          AND scope_environment_endpoint.environment_id = ANY(${parameter}::uuid[])
      )`;
    case 'notification-attempts':
      return `EXISTS (
        SELECT 1 FROM notification_deliveries scope_environment_delivery
        WHERE scope_environment_delivery.organisation_id = ${alias}.organisation_id
          AND scope_environment_delivery.id = ${alias}.delivery_id
          AND ${environmentCondition('notification-deliveries', parameter, 'scope_environment_delivery')}
      )`;
    case 'rollback-plans':
      return `${deployment(`${alias}.source_deployment_id`)} AND ${deployment(`${alias}.candidate_deployment_id`)}`;
    default:
      return `${parameter}::uuid[] IS NULL`;
  }
}

export function scopeCondition(
  resource: string,
  projects: string,
  environments: string,
  alias = 't',
): string {
  // Both restrictions must match the same target; independent EXISTS checks would leak agents
  // with one permitted project target and a different permitted environment target.
  if (resource === 'agents') {
    return `((${projects}::uuid[] IS NULL AND ${environments}::uuid[] IS NULL) OR EXISTS (
      SELECT 1 FROM deployment_targets scope_agent_target
      WHERE scope_agent_target.organisation_id = ${alias}.organisation_id
        AND scope_agent_target.agent_id = ${alias}.id
        AND (${projects}::uuid[] IS NULL OR scope_agent_target.project_id = ANY(${projects}::uuid[]))
        AND (${environments}::uuid[] IS NULL OR scope_agent_target.environment_id = ANY(${environments}::uuid[]))
    ))`;
  }

  return `(${projects}::uuid[] IS NULL OR (${projectCondition(resource, projects, alias)}))
    AND (${environments}::uuid[] IS NULL OR (${environmentCondition(resource, environments, alias)}))`;
}

const tables: Record<string, string> = {
  deployments: 'deployments',
  runbooks: 'runbooks',
  'runbook-versions': 'runbook_versions',
  'runbook-plans': 'runbook_plans',
  'runbook-runs': 'runbook_runs',
  'runbook-schedules': 'runbook_schedules',
  secrets: 'deployment_secrets',
  'rollback-plans': 'rollback_plans',
  'notification-endpoints': 'notification_endpoints',
  'notification-deliveries': 'notification_deliveries',
};

// Runs before handlers and idempotency replay. Environment ownership is immutable.
export async function enforceEnvironmentRequest(db: Database, req: FastifyRequest) {
  const ids = req.principal.environment_ids;

  if (!ids) {
    return;
  }

  const route = req.routeOptions.url?.replace(/^\/api\/v1/, '');
  const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${route}`;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = req.query as Record<string, unknown>;
  const params = req.params as Record<string, unknown>;

  const denied = () =>
    new DomainError(
      'ENVIRONMENT_SCOPE_REQUIRED',
      'This API token cannot access that environment or workspace operation.',
      403,
    );

  const environment = (value: unknown) => {
    const id = z.string().uuid().parse(value).toLowerCase();

    if (!ids.includes(id)) {
      throw denied();
    }
  };

  const record = async (resource: string, value: unknown) => {
    const id = z.string().uuid().parse(value);

    const row = await db.query(
      `SELECT 1 FROM ${tables[resource]} t WHERE t.organisation_id=$1 AND t.id=$2 AND ${environmentCondition(resource, '$3')}`,
      [req.principal.organisation_id, id, ids],
    );

    if (!row.rowCount) {
      throw new DomainError('NOT_FOUND', 'Resource not found.', 404);
    }
  };

  if (
    [
      'GET /snapshot',
      'GET /execution',
      'GET /integrations',
      'GET /providers',
      'GET /notifications/configuration',
      'GET /resources/:resource',
      'GET /resources/:resource/:id',
      'GET /artifacts/:id/download',
      'POST /processes/validate',
      'POST /runbooks/validate',
    ].includes(key)
  ) {
    return;
  }

  if (['GET /secrets', 'GET /releases/:id/promotion'].includes(key)) {
    environment(query.environment_id);

    return;
  }

  if (
    [
      'POST /deployments',
      'POST /secrets',
      'POST /notifications/endpoints',
      'POST /runbooks',
    ].includes(key)
  ) {
    if (key === 'POST /notifications/endpoints' && !body.environment_id) {
      throw denied();
    }

    environment(body.environment_id);

    return;
  }

  if (key === 'POST /runbook-plans') {
    return record('runbook-versions', body.runbook_version_id);
  }

  if (key === 'POST /runbook-schedules') {
    return record('runbook-plans', body.runbook_plan_id);
  }

  if (key === 'POST /rollback-plans') {
    await record('deployments', body.source_deployment_id);
    await record('deployments', body.candidate_deployment_id);

    return;
  }

  const records: Record<string, string> = {
    'POST /runbooks/:id/versions': 'runbooks',
    'POST /runbook-plans/:id/request': 'runbook-plans',
    'POST /runbook-schedules/:id/state': 'runbook-schedules',
    'GET /runbook-runs/:id/secret-bindings': 'runbook-runs',
    'POST /runbook-runs/:id/approve': 'runbook-runs',
    'POST /runbook-runs/:id/reject': 'runbook-runs',
    'POST /runbook-runs/:id/cancel': 'runbook-runs',
    'GET /deployments/:id/rollback-candidates': 'deployments',
    'GET /deployments/:id/secret-bindings': 'deployments',
    'POST /deployments/:id/approve': 'deployments',
    'POST /deployments/:id/reject': 'deployments',
    'POST /deployments/:id/cancel': 'deployments',
    'POST /rollback-plans/:id/request': 'rollback-plans',
    'POST /secrets/:id/versions': 'secrets',
    'POST /secrets/:id/revoke': 'secrets',
    'POST /notifications/endpoints/:id/state': 'notification-endpoints',
    'POST /notifications/deliveries/:id/retry': 'notification-deliveries',
  };

  if (Object.hasOwn(records, key)) {
    return record(records[key], params.id);
  }

  throw denied();
}

// Promotion still evaluates the workspace policy. Only its eligibility result is shared when
// the prerequisite is outside the token scope; its name, identifier and evidence stay private.
// Applied after reads and cached mutation responses, without changing persisted audit evidence.
export function redactEnvironmentEvidence(value: unknown, ids: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactEnvironmentEvidence(item, ids));
  }

  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) {
    return value;
  }

  const row = value as Record<string, unknown>;
  const policy = row.policy_snapshot as Record<string, unknown> | undefined;
  const source = row.promotion_from_environment_id ?? policy?.promotion_from_environment_id;
  const hidden = typeof source === 'string' && !ids.includes(source);

  const redacted = Object.fromEntries(
    Object.entries(row).map(([key, item]) => [
      key,
      hidden &&
      [
        'promotion_from_environment_id',
        'prerequisite_name',
        'source_deployment_id',
        'promotion_source_deployment_id',
      ].includes(key)
        ? null
        : redactEnvironmentEvidence(item, ids),
    ]),
  );

  return hidden ? { ...redacted, prerequisite_restricted: true } : redacted;
}
