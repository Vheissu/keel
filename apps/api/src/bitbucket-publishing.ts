import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transaction } from '../../../packages/database/src/index.js';
import { DomainError, type Principal } from '../../../packages/domain/src/index.js';
import type { BitbucketRun } from '../../../packages/integrations/src/bitbucket-pipelines.js';
import { sha256 } from './artifact-store.js';
import { bitbucketPublishInput } from './bitbucket-input.js';
import {
  adapterConnection,
  importColumns,
  IntegrationService,
  type ProviderConnectionRecord,
} from './integration-service.js';

export function verifyBitbucketRun(
  connection: ProviderConnectionRecord,
  run: BitbucketRun,
  commit: string,
) {
  if (
    run.repositoryId !== connection.repository_id ||
    run.targetType !== 'pipeline_ref_target' ||
    run.refType !== 'branch' ||
    run.branch !== connection.branch ||
    run.pipelineId !== connection.workflow_id ||
    run.commit !== commit
  ) {
    throw new DomainError(
      'RUN_NOT_TRUSTED',
      'The pipeline does not match this connection’s repository, branch, selector and commit.',
      422,
    );
  }
}

export async function registerBitbucketPublishing(
  app: FastifyInstance,
  service: IntegrationService,
) {
  const authenticated = new WeakMap<FastifyRequest, ProviderConnectionRecord>();

  app.post<{ Params: { id: string } }>(
    '/publish/bitbucket/:id',
    {
      bodyLimit: 25 * 1024 * 1024,
      onRequest: async (req) => {
        const id = z.string().uuid().parse(req.params.id);
        const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];

        const result = await service.control.db.query<ProviderConnectionRecord>(
          `
            SELECT
              *
            FROM
              provider_connections
            WHERE
              id = $1
              AND provider = 'bitbucket-pipelines'
              AND enabled = TRUE
          `,
          [id],
        );

        const connection = result.rows[0];

        if (
          !connection ||
          !token ||
          !timingSafeEqual(
            Buffer.from(sha256(token), 'hex'),
            Buffer.from(sha256(service.bitbucketCredentials(connection).publish_secret), 'hex'),
          )
        ) {
          throw new DomainError('INVALID_PUBLISH_TOKEN', 'Publisher authentication failed.', 401);
        }

        authenticated.set(req, connection);
      },
    },
    async (req, reply) => {
      const connection = authenticated.get(req)!;

      const input = bitbucketPublishInput.parse({
        run_id: req.headers['x-bitbucket-pipeline'],
        step_id: req.headers['x-bitbucket-step'],
        commit: req.headers['x-bitbucket-commit'],
        digest: req.headers['x-artifact-sha256'],
      });

      const bytes = req.body;

      if (!Buffer.isBuffer(bytes) || !bytes.length) {
        throw new DomainError(
          'INVALID_ARTIFACT',
          'Send a non-empty artifact as application/octet-stream.',
        );
      }

      if (sha256(bytes) !== input.digest) {
        throw new DomainError(
          'DIGEST_MISMATCH',
          'Artifact bytes do not match the supplied SHA-256 digest.',
        );
      }

      const submission = await transaction(service.control.db, async (tx) => {
        // Serialise submissions for this connection, including duplicate pipeline uploads.
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
            FOR UPDATE
          `,
          [connection.id, connection.credential_revision],
        );

        if (!current.rowCount) {
          throw new DomainError(
            'CONNECTION_CHANGED',
            'The connection changed during upload. Retry with its current credentials.',
            409,
          );
        }

        const existing = await tx.query(
          `
            SELECT
              *
            FROM
              artifact_imports
            WHERE
              connection_id = $1
              AND run_id = $2
              AND run_attempt = 1
          `,
          [connection.id, input.run_id],
        );

        const previous = existing.rows[0];

        if (previous) {
          if (
            previous.candidate_digest !== input.digest ||
            previous.candidate_commit !== input.commit ||
            previous.candidate_step_id !== input.step_id
          ) {
            throw new DomainError(
              'PUBLISH_CONFLICT',
              'This pipeline already submitted a different artifact. Start a new pipeline.',
              409,
            );
          }

          return { id: previous.id, status: previous.status, duplicate: true };
        }

        const adapter = service.bitbucketAdapter(connection);
        const run = await adapter.getRun(adapterConnection(connection), input.run_id);

        verifyBitbucketRun(connection, run, input.commit);
        const step = await adapter.getStep(input.run_id, input.step_id);

        if (run.status !== 'running' || step.state.name !== 'IN_PROGRESS') {
          throw new DomainError(
            'PUBLISH_STEP_NOT_RUNNING',
            'Publish from a running pipeline step. Completed runs cannot receive new artifacts.',
            409,
          );
        }

        await service.control.store.put(connection.organisation_id, input.digest, bytes);
        const id = randomUUID();

        const result = await tx.query(
          `
            INSERT INTO
              artifact_imports (
                id,
                organisation_id,
                project_id,
                connection_id,
                requested_by,
                run_id,
                run_attempt,
                candidate_digest,
                candidate_commit,
                candidate_step_id
              )
            VALUES
              ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
            RETURNING
              ${importColumns}
          `,
          [
            id,
            connection.organisation_id,
            connection.project_id,
            connection.id,
            connection.created_by,
            input.run_id,
            input.digest,
            input.commit,
            input.step_id,
          ],
        );

        const principal: Principal = {
          organisation_id: connection.organisation_id,
          actor_id: connection.created_by,
          name: 'Bitbucket publisher',
          permissions: ['read', 'write'],
        };

        await service.control.audit(tx, principal, 'artifact.submitted', id, {
          connection_id: connection.id,
          run_id: input.run_id,
          step_id: input.step_id,
          digest: input.digest,
          authentication: 'connection-publish-secret',
        });

        return { ...result.rows[0], duplicate: false };
      });

      return reply.code(202).send(submission);
    },
  );
}
