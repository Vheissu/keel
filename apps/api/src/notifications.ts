import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Transaction } from '../../../packages/database/src/index.js';
import {
  DomainError,
  requirePermission,
  type ExecutionRequest,
} from '../../../packages/domain/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { CredentialVault } from './credential-vault.js';
import { sha256 } from './artifact-store.js';

export const notificationStatuses = [
  'awaiting_approval',
  'queued',
  'running',
  'cancel_requested',
  'reconciliation_required',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
] as const;

// Deploy and rollback requests are both deployment events; runbook runs are reported separately.
export const notificationWorkKinds = ['deployment', 'runbook'] as const;

export const endpointColumns =
  'id, name, origin, project_id, environment_id, statuses, work_kinds, enabled, revision, created_at';

export const deliveryColumns =
  'id, endpoint_id, deployment_id, event_id, status, attempt_count, next_attempt_at, last_code, last_http_status, delivered_at, created_at';

export function notificationVault() {
  return process.env.KEEL_CREDENTIAL_KEY
    ? new CredentialVault(process.env.KEEL_CREDENTIAL_KEY, 'notifications')
    : undefined;
}

// Operators explicitly approve destinations on the server. Paths/query strings may contain
// credentials, so only the origin is exposed by metadata reads and audit records.
export function notificationOrigins() {
  return (process.env.KEEL_NOTIFICATION_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function validateNotificationUrl(value: string, allowed = notificationOrigins()) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new DomainError('INVALID_DESTINATION', 'Use an allowed HTTPS destination.');
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !allowed.includes(url.origin)
  ) {
    throw new DomainError('INVALID_DESTINATION', 'Use an allowed HTTPS destination.');
  }

  return url;
}

const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    url: z.string().min(1).max(2048),
    signing_secret: z.string().regex(/^[\x21-\x7e]{32,256}$/),
    project_id: z.string().uuid().nullable().default(null),
    environment_id: z.string().uuid().nullable().default(null),
    statuses: z
      .array(z.enum(notificationStatuses))
      .min(1)
      .max(9)
      .transform((values) => [...new Set(values)]),
    work_kinds: z
      .array(z.enum(notificationWorkKinds))
      .min(1)
      .max(2)
      .default(['deployment'])
      .transform((values) => [...new Set(values)]),
  })
  .strict();

// Both payloads are event-time metadata snapshots. Runbook payloads exclude task commands, reviewed
// input values and secret bindings.
const deploymentPayload = `
  jsonb_build_object(
    'id',
    d.id,
    'status',
    event.status,
    'kind',
    d.kind,
    'project_id',
    d.project_id,
    'project_name',
    p.name,
    'environment_id',
    d.environment_id,
    'environment_name',
    e.name,
    'release_id',
    d.release_id,
    'release_version',
    r.version,
    'result_code',
    d.result_code
  )
`;

const runbookPayload = `
  jsonb_build_object(
    'id',
    d.id,
    'status',
    event.status,
    'project_id',
    d.project_id,
    'project_name',
    p.name,
    'environment_id',
    d.environment_id,
    'environment_name',
    e.name,
    'runbook_id',
    b.id,
    'runbook_name',
    b.name,
    'runbook_slug',
    b.slug,
    'runbook_version_id',
    v.id,
    'runbook_version',
    v.version,
    'result_code',
    d.result_code
  )
`;

export async function enqueueNotifications(
  tx: Transaction,
  request: ExecutionRequest,
  eventId: string,
) {
  const runbook = request.kind === 'runbook';

  await tx.query(
    `
      INSERT INTO
        notification_deliveries (
          id,
          organisation_id,
          endpoint_id,
          event_id,
          deployment_id,
          payload
        )
      SELECT
        gen_random_uuid(),
        d.organisation_id,
        n.id,
        event.id,
        d.id,
        jsonb_build_object(
          'schema_version',
          1,
          'event_id',
          event.id,
          'type',
          $4 || '.' || event.status,
          'occurred_at',
          event.created_at,
          $5::text,
          ${runbook ? runbookPayload : deploymentPayload}
        )
      FROM
        deployments d
        JOIN deployment_events event ON event.id = $3
        AND event.organisation_id = d.organisation_id
        AND event.deployment_id = d.id
        JOIN projects p ON p.id = d.project_id
        AND p.organisation_id = d.organisation_id
        JOIN environments e ON e.id = d.environment_id
        AND e.organisation_id = d.organisation_id
        ${
          runbook
            ? `JOIN runbook_versions v ON v.id = d.runbook_version_id
        AND v.organisation_id = d.organisation_id
        JOIN runbooks b ON b.id = v.runbook_id
        AND b.organisation_id = v.organisation_id`
            : `JOIN releases r ON r.id = d.release_id
        AND r.organisation_id = d.organisation_id`
        }
        JOIN notification_endpoints n ON n.organisation_id = d.organisation_id
      WHERE
        d.organisation_id = $1
        AND d.id = $2
        AND n.enabled
        AND $4 = ANY (n.work_kinds)
        AND (
          n.project_id IS NULL
          OR n.project_id = d.project_id
        )
        AND (
          n.environment_id IS NULL
          OR n.environment_id = d.environment_id
        )
        AND event.status = ANY (n.statuses)
      ON CONFLICT (endpoint_id, event_id) DO NOTHING
    `,
    [
      request.organisation_id,
      request.id,
      eventId,
      runbook ? 'runbook' : 'deployment',
      runbook ? 'runbook_run' : 'deployment',
    ],
  );
}

export async function registerNotificationRoutes(api: FastifyInstance, control: ControlPlane) {
  api.get('/notifications/configuration', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');

    return {
      configured: !!notificationVault() && notificationOrigins().length > 0,
      allowed_origins: notificationOrigins(),
    };
  });

  api.post('/notifications/endpoints', { bodyLimit: 8192 }, async (req, reply) => {
    requirePermission(req.principal, 'write');
    const parsed = inputSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new DomainError(
        'INVALID_NOTIFICATION',
        'Supply a name, allowed HTTPS URL, 32–256 character signing secret, valid scopes, states and event sources.',
      );
    }

    const input = parsed.data;
    const url = validateNotificationUrl(input.url);
    const vault = notificationVault();

    if (!vault) {
      throw new DomainError(
        'NOTIFICATIONS_UNAVAILABLE',
        'Configure the notification credential key first.',
        503,
      );
    }

    reply.header('Cache-Control', 'no-store');

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      vault.fingerprint(JSON.stringify(input)),
      async (tx) => {
        for (const [table, id] of [
          ['projects', input.project_id],
          ['environments', input.environment_id],
        ]) {
          if (
            id &&
            !(
              await tx.query(`SELECT 1 FROM ${table} WHERE organisation_id=$1 AND id=$2`, [
                req.principal.organisation_id,
                id,
              ])
            ).rowCount
          ) {
            throw new DomainError('NOT_FOUND', 'The notification scope was not found.', 404);
          }
        }

        const id = randomUUID();

        const result = await tx.query(
          `
            INSERT INTO
              notification_endpoints (
                id,
                organisation_id,
                name,
                origin,
                credentials,
                project_id,
                environment_id,
                statuses,
                work_kinds
              )
            VALUES
              ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING
              ${endpointColumns}
          `,
          [
            id,
            req.principal.organisation_id,
            input.name,
            url.origin,
            vault.encrypt(req.principal.organisation_id, id, {
              url: url.href,
              secret: input.signing_secret,
            }),
            input.project_id,
            input.environment_id,
            input.statuses,
            input.work_kinds,
          ],
        );

        await control.audit(tx, req.principal, 'notification.endpoint_created', id, {
          origin: url.origin,
        });

        return result.rows[0];
      },
    );
  });

  api.post<{ Params: { id: string } }>('/notifications/endpoints/:id/state', async (req, reply) => {
    requirePermission(req.principal, 'write');
    const id = z.string().uuid().parse(req.params.id);

    const input = z
      .object({ enabled: z.boolean(), expected_revision: z.number().int().positive() })
      .strict()
      .parse(req.body);

    reply.header('Cache-Control', 'no-store');

    return control.mutate(
      req.principal,
      String(req.headers['idempotency-key'] ?? ''),
      sha256(`notification-state:${id}:${JSON.stringify(input)}`),
      async (tx) => {
        const result = await tx.query(
          `
            UPDATE notification_endpoints
            SET
              enabled = $3,
              revision = revision + 1
            WHERE
              organisation_id = $1
              AND id = $2
              AND revision = $4
            RETURNING
              ${endpointColumns}
          `,
          [req.principal.organisation_id, id, input.enabled, input.expected_revision],
        );

        if (!result.rowCount) {
          throw new DomainError(
            'NOTIFICATION_CONFLICT',
            'The destination was changed or is unavailable. Refresh and try again.',
            409,
          );
        }

        if (!input.enabled) {
          await tx.query(
            `
              UPDATE notification_deliveries
              SET
                status = 'cancelled',
                last_code = 'DESTINATION_DISABLED'
              WHERE
                organisation_id = $1
                AND endpoint_id = $2
                AND status IN ('pending', 'retrying')
            `,
            [req.principal.organisation_id, id],
          );
        }

        await control.audit(
          tx,
          req.principal,
          input.enabled ? 'notification.endpoint_enabled' : 'notification.endpoint_disabled',
          id,
        );

        return result.rows[0];
      },
    );
  });

  api.post<{ Params: { id: string } }>(
    '/notifications/deliveries/:id/retry',
    async (req, reply) => {
      requirePermission(req.principal, 'write');
      const id = z.string().uuid().parse(req.params.id);

      reply.header('Cache-Control', 'no-store');

      return control.mutate(
        req.principal,
        String(req.headers['idempotency-key'] ?? ''),
        sha256(`notification-retry:${id}`),
        async (tx) => {
          const result = await tx.query(
            `
              UPDATE notification_deliveries d
              SET
                status = 'pending',
                cycle_attempts = 0,
                next_attempt_at = now(),
                lease_id = NULL,
                lease_expires_at = NULL
              WHERE
                d.organisation_id = $1
                AND d.id = $2
                AND d.status IN ('failed', 'cancelled')
                AND EXISTS (
                  SELECT
                    1
                  FROM
                    notification_endpoints n
                  WHERE
                    n.organisation_id = d.organisation_id
                    AND n.id = d.endpoint_id
                    AND n.enabled
                )
              RETURNING
                ${deliveryColumns
                  .split(', ')
                  .map((c) => `d.${c}`)
                  .join(', ')}
            `,
            [req.principal.organisation_id, id],
          );

          if (!result.rowCount) {
            throw new DomainError(
              'NOTIFICATION_CONFLICT',
              'Retry a failed or cancelled delivery to an enabled destination.',
              409,
            );
          }

          await control.audit(tx, req.principal, 'notification.delivery_retried', id);

          return result.rows[0];
        },
      );
    },
  );
}
