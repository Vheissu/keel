import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transaction } from '../../../packages/database/src/index.js';
import { DomainError, type Principal } from '../../../packages/domain/src/index.js';
import { sha256 } from './artifact-store.js';
import { IntegrationService, type ProviderConnectionRecord } from './integration-service.js';

const runEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int().safe().positive() }),
  workflow_run: z.object({
    id: z.number().int().safe().positive(),
    run_attempt: z.number().int().positive().max(10000),
    workflow_id: z.number().int().safe().positive(),
    status: z.string(),
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable(),
  }),
});

export async function registerGitHubWebhook(app: FastifyInstance, service: IntegrationService) {
  await app.register(async (webhooks) => {
    // Keep the signed bytes intact; reserialising parsed JSON would change the signature.
    webhooks.removeContentTypeParser('application/json');

    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    webhooks.post<{ Params: { id: string } }>(
      '/webhooks/github/:id',
      { bodyLimit: 512 * 1024 },
      async (req, reply) => {
        const id = z.string().uuid().parse(req.params.id);
        const deliveryId = z.string().uuid().parse(req.headers['x-github-delivery']);

        const event = z
          .string()
          .regex(/^[a-z_]{1,64}$/)
          .parse(req.headers['x-github-event']);

        const signature = String(req.headers['x-hub-signature-256'] ?? '');

        const result = await service.control.db.query<ProviderConnectionRecord>(
          `
            SELECT
              *
            FROM
              provider_connections
            WHERE
              id = $1
              AND enabled = TRUE
              AND provider = 'github-actions'
          `,
          [id],
        );

        const connection = result.rows[0];

        if (!connection || !Buffer.isBuffer(req.body) || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
          throw new DomainError('INVALID_WEBHOOK', 'Webhook authentication failed.', 401);
        }

        const expected = createHmac('sha256', service.credentials(connection).webhook_secret)
          .update(req.body)
          .digest();

        const supplied = Buffer.from(signature.slice(7), 'hex');

        if (!timingSafeEqual(expected, supplied)) {
          throw new DomainError('INVALID_WEBHOOK', 'Webhook authentication failed.', 401);
        }

        let payload: unknown;

        try {
          payload = JSON.parse(req.body.toString('utf8'));
        } catch {
          throw new DomainError('INVALID_WEBHOOK', 'The webhook body must be valid JSON.');
        }

        let run: z.infer<typeof runEvent>['workflow_run'] | undefined;

        if (event === 'workflow_run') {
          const parsed = runEvent.parse(payload);
          const candidate = parsed.workflow_run;

          if (
            parsed.action === 'completed' &&
            candidate.status === 'completed' &&
            candidate.conclusion === 'success' &&
            String(parsed.repository.id) === connection.repository_id &&
            String(candidate.workflow_id) === connection.workflow_id &&
            candidate.head_branch === connection.branch
          ) {
            run = candidate;
          }
        }

        const hash = sha256(req.body);
        const outcome = run ? 'accepted' : 'ignored';

        const delivery = await transaction(service.control.db, async (tx) => {
          // Disabling or rotating a connection invalidates requests verified with its old credentials.
          const current = await tx.query(
            `
              SELECT
                1
              FROM
                provider_connections
              WHERE
                id = $1
                AND enabled = TRUE
                AND credential_revision = $2
              FOR SHARE
            `,
            [id, connection.credential_revision],
          );

          if (!current.rowCount) {
            throw new DomainError(
              'CONNECTION_CHANGED',
              'The connection changed. Redeliver the webhook.',
              409,
            );
          }

          const inserted = await tx.query(
            `
              INSERT INTO
                provider_webhook_deliveries (
                  id,
                  organisation_id,
                  connection_id,
                  delivery_id,
                  event,
                  payload_hash,
                  payload,
                  outcome
                )
              VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (connection_id, delivery_id) DO NOTHING
              RETURNING
                id
            `,
            [
              randomUUID(),
              connection.organisation_id,
              id,
              deliveryId,
              event,
              hash,
              payload,
              outcome,
            ],
          );

          if (!inserted.rowCount) {
            const previous = (
              await tx.query(
                `
                  SELECT
                    payload_hash,
                    event,
                    outcome
                  FROM
                    provider_webhook_deliveries
                  WHERE
                    connection_id = $1
                    AND delivery_id = $2
                `,
                [id, deliveryId],
              )
            ).rows[0];

            if (previous.payload_hash !== hash || previous.event !== event) {
              throw new DomainError(
                'WEBHOOK_REPLAY_CONFLICT',
                'This delivery ID was already used for a different payload.',
                409,
              );
            }

            return { outcome: previous.outcome, duplicate: true };
          }

          if (run) {
            const principal: Principal = {
              organisation_id: connection.organisation_id,
              actor_id: connection.created_by,
              name: 'GitHub webhook',
              permissions: ['read', 'write'],
            };

            await service.enqueue(tx, principal, id, {
              run_id: String(run.id),
              run_attempt: run.run_attempt,
            });
          }

          return { outcome, duplicate: false };
        });

        return reply.code(202).send(delivery);
      },
    );
  });
}
