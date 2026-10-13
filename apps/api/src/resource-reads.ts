import { scopeCondition } from './environment-access.js';
import { endpointColumns, deliveryColumns } from './notifications.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  transaction,
  readOnlySnapshot,
  type Database,
} from '../../../packages/database/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { connectionColumns, importColumns } from './integration-service.js';

interface Resource {
  table: string;
  columns: string;
  joins?: string;
  search: string[];
  filters?: string[];
}

const projectJoin =
  'JOIN projects p ON p.organisation_id = t.organisation_id AND p.id = t.project_id';

const environmentJoin =
  'JOIN environments e ON e.organisation_id = t.organisation_id AND e.id = t.environment_id';

const qualify = (columns: string) =>
  columns
    .split(',')
    .map((column) => `t.${column.trim()}`)
    .join(', ');

// SQL identifiers and projections come only from this registry, never from query parameters.
const resources: Record<string, Resource> = {
  'notification-endpoints': {
    table: 'notification_endpoints',
    columns: qualify(endpointColumns),
    search: ['t.name', 't.origin'],
    filters: ['project_id', 'environment_id'],
  },
  'notification-deliveries': {
    table: 'notification_deliveries',
    columns: `${qualify(deliveryColumns)}, n.name AS endpoint_name`,
    joins:
      'JOIN notification_endpoints n ON n.organisation_id=t.organisation_id AND n.id=t.endpoint_id',
    search: ['n.name', 't.status', 't.deployment_id::text', 't.last_code'],
    filters: ['status', 'deployment_id', 'endpoint_id'],
  },
  'notification-attempts': {
    table: 'notification_attempts',
    columns: 't.*',
    search: ['t.code', 't.delivery_id::text'],
    filters: ['delivery_id'],
  },
  projects: { table: 'projects', columns: 't.*', search: ['t.name', 't.slug', 't.description'] },
  environments: {
    table: 'environments',
    columns: 't.*, prerequisite.name AS prerequisite_name',
    joins: `LEFT JOIN environments prerequisite
        ON prerequisite.organisation_id = t.organisation_id
        AND prerequisite.id = t.promotion_from_environment_id`,
    search: ['t.name', 't.slug'],
  },
  artifacts: {
    table: 'artifacts',
    columns: 't.*, p.name AS project_name',
    joins: projectJoin,
    search: ['t.name', 't.version', 'p.name', 't.digest'],
    filters: ['project_id'],
  },
  releases: {
    table: 'releases',
    columns: 't.*, p.name AS project_name',
    joins: projectJoin,
    search: ['t.version', 'p.name'],
    filters: ['project_id'],
  },
  deployments: {
    table: 'deployments',
    columns:
      't.*, p.name AS project_name, e.name AS environment_name, r.version AS release_version',
    joins: `${projectJoin}
      ${environmentJoin}
      JOIN releases r ON r.organisation_id = t.organisation_id AND r.id = t.release_id`,
    search: ['p.name', 'e.name', 'r.version', 't.status', "replace(t.status, '_', ' ')"],
    filters: ['project_id', 'environment_id', 'status'],
  },
  audit: {
    table: 'audit_events',
    columns: 't.*, a.name AS actor_name',
    joins: 'JOIN actors a ON a.organisation_id = t.organisation_id AND a.id = t.actor_id',
    search: ['t.action', 'a.name', 't.resource_id::text'],
  },
  agents: {
    table: 'deployment_agents',
    columns: 't.id, t.name, t.state, t.last_seen_at, t.created_at',
    search: ['t.name', 't.state'],
    filters: ['state'],
  },
  targets: {
    table: 'deployment_targets',
    columns:
      't.*, p.name AS project_name, e.name AS environment_name, a.name AS agent_name, r.version AS release_version',
    joins: `${projectJoin}
      ${environmentJoin}
      JOIN deployment_agents a ON a.organisation_id = t.organisation_id AND a.id = t.agent_id
      LEFT JOIN releases r ON r.organisation_id = t.organisation_id AND r.id = t.current_release_id`,
    search: ['t.name', 'p.name', 'e.name', 'a.name'],
    filters: ['project_id', 'environment_id', 'agent_id'],
  },
  attempts: {
    table: 'deployment_attempts',
    columns: `t.id, t.deployment_id, t.target_id, t.agent_id, t.state, t.fence, t.result_code, t.phase,
      t.phase_updated_at, t.lease_expires_at, t.created_at, t.updated_at, target.name AS target_name`,
    joins:
      'JOIN deployment_targets target ON target.organisation_id = t.organisation_id AND target.id = t.target_id',
    search: ['target.name', 't.state', 't.result_code', 't.deployment_id::text'],
    filters: ['agent_id', 'state'],
  },
  connections: {
    table: 'provider_connections',
    columns: `${qualify(connectionColumns)}, p.name AS project_name`,
    joins: projectJoin,
    search: ['t.name', 't.repository', 't.provider', 'p.name'],
    filters: ['project_id'],
  },
  imports: {
    table: 'artifact_imports',
    columns: `${qualify(importColumns)}, c.name AS connection_name`,
    joins:
      'JOIN provider_connections c ON c.organisation_id = t.organisation_id AND c.id = t.connection_id',
    search: ['t.run_id', 't.status', 'c.name'],
    filters: ['project_id', 'connection_id', 'status'],
  },
  secrets: {
    table: 'deployment_secrets',
    columns:
      't.id, t.project_id, t.environment_id, t.name, t.revision, t.current_version, t.disabled, t.created_at, t.updated_at',
    search: ['t.name'],
    filters: ['project_id', 'environment_id'],
  },
};

const querySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .pipe(z.number().max(100))
      .optional(),
    cursor: z.string().max(2048).optional(),
    q: z.string().trim().max(200).optional(),
    endpoint_id: z.string().uuid().optional(),
    delivery_id: z.string().uuid().optional(),
    deployment_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
    environment_id: z.string().uuid().optional(),
    connection_id: z.string().uuid().optional(),
    agent_id: z.string().uuid().optional(),
    status: z.string().min(1).max(40).optional(),
    state: z.string().min(1).max(40).optional(),
  })
  .strict();

const position = z
  .object({ time: z.string().datetime({ precision: 6 }), id: z.string().uuid() })
  .strict();

const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string(),
    direction: z.enum(['after', 'before']),
    anchor: position,
    edge: position,
  })
  .strict();

type Cursor = z.infer<typeof cursorSchema>;

function resource(name: string) {
  const result = Object.hasOwn(resources, name) ? resources[name] : undefined;

  if (!result) {
    throw new DomainError('NOT_FOUND', 'Resource not found.', 404);
  }

  return result;
}

function decode(value: string, scope: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error();
    }

    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));

    if (cursor.scope !== scope) {
      throw new Error();
    }

    return cursor;
  } catch {
    throw new DomainError(
      'INVALID_CURSOR',
      'This page link is invalid for the selected resource or filters. Return to the first page.',
    );
  }
}

export async function listResource(
  db: Database,
  org: string,
  name: string,
  input: unknown,
  projectIds: string[] | null = null,
  environmentIds: string[] | null = null,
) {
  const definition = resource(name);
  const query = querySchema.parse(input);
  const { cursor: encoded, limit = 25, q = '', ...filters } = query;

  for (const key of Object.keys(filters)) {
    if (!definition.filters?.includes(key)) {
      throw new DomainError('INVALID_FILTER', 'This filter is not supported for this resource.');
    }
  }

  if (name === 'secrets' && (!filters.project_id || !filters.environment_id)) {
    throw new DomainError(
      'INVALID_FILTER',
      'Choose a project and environment for secret metadata.',
    );
  }

  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        org,
        name,
        q,
        Object.entries(filters).sort(),
        projectIds?.slice().sort(),
        environmentIds?.slice().sort(),
      ]),
    )
    .digest('hex');

  const cursor = encoded ? decode(encoded, scope) : null;

  return transaction(
    db,
    async (tx) => {
      const values: unknown[] = [org];
      const conditions = ['t.organisation_id = $1'];

      const parameter = (value: unknown) => {
        values.push(value);

        return `$${values.length}`;
      };

      conditions.push(scopeCondition(name, parameter(projectIds), parameter(environmentIds)));

      for (const [key, value] of Object.entries(filters)) {
        conditions.push(`t.${key} = ${parameter(value)}`);
      }

      if (q) {
        const search = parameter(`%${q.replace(/[\\%_]/g, '\\$&')}%`);

        conditions.push(
          `(${definition.search.map((column) => `${column} ILIKE ${search}`).join(' OR ')})`,
        );
      }

      const from = `${definition.table} t ${definition.joins || ''}`;

      const total = Number(
        (await tx.query(`SELECT count(*) FROM ${from} WHERE ${conditions.join(' AND ')}`, values))
          .rows[0].count,
      );

      if (cursor) {
        conditions.push(
          `(t.created_at, t.id) <= (${parameter(cursor.anchor.time)}::timestamptz, ${parameter(cursor.anchor.id)}::uuid)`,
        );

        conditions.push(
          `(t.created_at, t.id) ${cursor.direction === 'after' ? '<' : '>'} (${parameter(cursor.edge.time)}::timestamptz, ${parameter(cursor.edge.id)}::uuid)`,
        );
      }

      const ascending = cursor?.direction === 'before';
      const order = ascending ? 'ASC' : 'DESC';

      const result = await tx.query(
        `
          SELECT
            ${definition.columns},
            to_char(
              t.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS cursor_time
          FROM
            ${from}
          WHERE
            ${conditions.join(' AND ')}
          ORDER BY
            t.created_at ${order},
            t.id ${order}
          LIMIT
            ${parameter(limit + 1)}
        `,
        values,
      );

      const more = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);

      if (ascending) {
        rows.reverse();
      }

      const at = (row: (typeof rows)[number]) => ({
        time: row.cursor_time as string,
        id: row.id as string,
      });

      const anchor = cursor?.anchor ?? (rows[0] ? at(rows[0]) : null);

      const make = (direction: Cursor['direction'], edge: Cursor['edge']) =>
        Buffer.from(JSON.stringify({ v: 1, scope, anchor, direction, edge })).toString('base64url');

      const first = rows[0] ? at(rows[0]) : cursor?.edge;
      const last = rows.at(-1) ? at(rows.at(-1)!) : cursor?.edge;
      const previous = ascending ? more : !!cursor;
      const next = ascending ? !!cursor : more;

      return {
        items: rows.map(({ cursor_time: _time, ...row }) => row),
        total,
        limit,
        previous_cursor: previous && first ? make('before', first) : null,
        next_cursor: next && last ? make('after', last) : null,
      };
    },
    readOnlySnapshot,
  );
}

export async function registerResourceReads(api: FastifyInstance, db: Database) {
  api.get<{ Params: { resource: string } }>('/resources/:resource', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    return listResource(
      db,
      req.principal.organisation_id,
      req.params.resource,
      req.query,
      req.principal.project_ids ?? null,
      req.principal.environment_ids ?? null,
    );
  });

  api.get<{ Params: { resource: string; id: string } }>(
    '/resources/:resource/:id',
    async (req, reply) => {
      const definition = resource(req.params.resource);
      const id = z.string().uuid().parse(req.params.id);

      const result = await db.query(
        `
          SELECT
            ${definition.columns}
          FROM
            ${definition.table} t ${definition.joins || ''}
          WHERE
            t.organisation_id = $1
            AND t.id = $2
            AND ${scopeCondition(req.params.resource, '$3', '$4')}
        `,
        [
          req.principal.organisation_id,
          id,
          req.principal.project_ids ?? null,
          req.principal.environment_ids ?? null,
        ],
      );

      if (!result.rows[0]) {
        throw new DomainError('NOT_FOUND', 'Resource not found.', 404);
      }

      reply.header('Cache-Control', 'no-store');

      return result.rows[0];
    },
  );
}
