import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';

// These identifiers are fixed server-side. Unknown resources fail closed for scoped tokens.
export function projectCondition(resource: string, parameter: string, alias = 't'): string {
  const direct: Record<string, string> = {
    projects: 'id',
    artifacts: 'project_id',
    releases: 'project_id',
    deployments: 'project_id',
    targets: 'project_id',
    connections: 'project_id',
    imports: 'project_id',
    secrets: 'project_id',
    'notification-endpoints': 'project_id',
  };

  if (Object.hasOwn(direct, resource)) {
    return `${alias}.${direct[resource]} = ANY(${parameter}::uuid[])`;
  }

  const deployment = (id: string) =>
    `EXISTS (
      SELECT 1 FROM deployments scope_deployment
      WHERE scope_deployment.organisation_id = ${alias}.organisation_id
        AND scope_deployment.id = ${id}
        AND scope_deployment.project_id = ANY(${parameter}::uuid[])
    )`;

  switch (resource) {
    case 'environments':
      // Reference the typed parameter even when the scope permits shared metadata.
      return `${parameter}::uuid[] IS NOT NULL`;
    case 'attempts':
      return deployment(`${alias}.deployment_id`);
    case 'agents':
      return `EXISTS (
        SELECT 1 FROM deployment_targets scope_target
        WHERE scope_target.organisation_id = ${alias}.organisation_id
          AND scope_target.agent_id = ${alias}.id
          AND scope_target.project_id = ANY(${parameter}::uuid[])
      )`;
    case 'notification-deliveries':
      return `${deployment(`${alias}.deployment_id`)} AND EXISTS (
        SELECT 1 FROM notification_endpoints scope_endpoint
        WHERE scope_endpoint.organisation_id = ${alias}.organisation_id
          AND scope_endpoint.id = ${alias}.endpoint_id
          AND scope_endpoint.project_id = ANY(${parameter}::uuid[])
      )`;
    case 'notification-attempts':
      return `EXISTS (
        SELECT 1 FROM notification_deliveries scope_delivery
        WHERE scope_delivery.organisation_id = ${alias}.organisation_id
          AND scope_delivery.id = ${alias}.delivery_id
          AND ${projectCondition('notification-deliveries', parameter, 'scope_delivery')}
      )`;
    case 'rollback-plans':
      return deployment(`${alias}.source_deployment_id`);
    default:
      return `${parameter}::uuid[] IS NULL`;
  }
}

const tables: Record<string, string> = {
  artifacts: 'artifacts',
  releases: 'releases',
  deployments: 'deployments',
  connections: 'provider_connections',
  imports: 'artifact_imports',
  secrets: 'deployment_secrets',
  'rollback-plans': 'rollback_plans',
  'notification-endpoints': 'notification_endpoints',
  'notification-deliveries': 'notification_deliveries',
};

// Runs after parsing the body and before any handler (including idempotency replay).
// Project ownership of these records is immutable. New routes require an explicit scope rule.
export async function enforceProjectRequest(db: Database, req: FastifyRequest) {
  const ids = req.principal.project_ids;

  if (!ids) {
    return;
  }

  const route = req.routeOptions.url?.replace(/^\/api\/v1/, '');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const key = `${method} ${route}`;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = req.query as Record<string, unknown>;
  const params = req.params as Record<string, unknown>;

  const denied = () =>
    new DomainError(
      'PROJECT_SCOPE_REQUIRED',
      'This API token cannot access that resource or workspace operation.',
      403,
    );

  const project = (value: unknown) => {
    const id = z.string().uuid().parse(value);

    if (!ids.includes(id)) {
      throw denied();
    }
  };

  const record = async (resource: string, value: unknown) => {
    const id = z.string().uuid().parse(value);

    const row = await db.query(
      `SELECT 1 FROM ${tables[resource]} t WHERE t.organisation_id=$1 AND t.id=$2 AND ${projectCondition(resource, '$3')}`,
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
      'POST /processes/validate',
    ].includes(key)
  ) {
    return;
  }

  if (['POST /artifacts', 'GET /secrets'].includes(key)) {
    project(query.project_id);

    return;
  }

  if (
    [
      'POST /releases',
      'POST /secrets',
      'POST /integrations/github',
      'POST /integrations/bitbucket',
      'POST /notifications/endpoints',
    ].includes(key)
  ) {
    project(body.project_id);

    return;
  }

  if (key === 'POST /deployments') {
    return record('releases', body.release_id);
  }

  if (key === 'POST /rollback-plans') {
    await record('deployments', body.source_deployment_id);
    await record('deployments', body.candidate_deployment_id);

    return;
  }

  const records: Record<string, string> = {
    'GET /artifacts/:id/download': 'artifacts',
    'GET /releases/:id/promotion': 'releases',
    'GET /deployments/:id/rollback-candidates': 'deployments',
    'GET /deployments/:id/secret-bindings': 'deployments',
    'POST /deployments/:id/approve': 'deployments',
    'POST /deployments/:id/reject': 'deployments',
    'POST /deployments/:id/cancel': 'deployments',
    'POST /rollback-plans/:id/request': 'rollback-plans',
    'POST /secrets/:id/versions': 'secrets',
    'POST /secrets/:id/revoke': 'secrets',
    'POST /integrations/:id/bitbucket-credentials': 'connections',
    'POST /integrations/:id/credentials': 'connections',
    'POST /integrations/:id/state': 'connections',
    'GET /integrations/:id/pipelines': 'connections',
    'POST /integrations/:id/imports': 'connections',
    'POST /imports/:id/retry': 'imports',
    'POST /notifications/endpoints/:id/state': 'notification-endpoints',
    'POST /notifications/deliveries/:id/retry': 'notification-deliveries',
  };

  if (Object.hasOwn(records, key)) {
    return record(records[key], params.id);
  }

  throw denied();
}
