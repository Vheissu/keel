import { randomUUID } from 'node:crypto';
import { DomainError, type Principal } from '../../../packages/domain/src/index.js';
import { ProviderError } from '../../../packages/integrations/src/github-actions.js';
import { sha256 } from './artifact-store.js';
import { adapterConnection, IntegrationService, type ImportJob } from './integration-service.js';

const maximumAttempts = 5;
const leaseSeconds = 120;

export class ArtifactImportWorker {
  constructor(private integrations: IntegrationService) {}

  private get db() {
    return this.integrations.control.db;
  }

  async runOnce(): Promise<boolean> {
    await this.db.query(
      `
        UPDATE artifact_imports
        SET
          status = 'failed',
          lease_token = NULL,
          lease_expires_at = NULL,
          error_code = 'IMPORT_RETRY_EXHAUSTED',
          error_message = 'The worker stopped during the final attempt. Retry this import.',
          updated_at = now()
        WHERE
          status = 'processing'
          AND lease_expires_at < now()
          AND attempts >= $1
      `,
      [maximumAttempts],
    );

    const claimed = await this.db.query<ImportJob>(
      `
        WITH
          candidate AS (
            SELECT
              id
            FROM
              artifact_imports
            WHERE
              attempts < $1
              AND (
                (
                  status = 'pending'
                  AND available_at <= now()
                )
                OR (
                  status = 'processing'
                  AND lease_expires_at < now()
                )
              )
            ORDER BY
              available_at,
              created_at
            FOR UPDATE
              SKIP LOCKED
            LIMIT
              1
          )
        UPDATE artifact_imports
        SET
          status = 'processing',
          attempts = attempts + 1,
          lease_token = $2,
          lease_expires_at = now() + ($3 * interval '1 second'),
          updated_at = now()
        WHERE
          id IN (
            SELECT
              id
            FROM
              candidate
          )
        RETURNING
          *
      `,
      [maximumAttempts, randomUUID(), leaseSeconds],
    );

    const job = claimed.rows[0];

    if (!job) {
      return false;
    }

    const heartbeat = setInterval(() => {
      void this.db
        .query(
          `
            UPDATE artifact_imports
            SET
              lease_expires_at = now() + ($3 * interval '1 second')
            WHERE
              id = $1
              AND lease_token = $2
              AND status = 'processing'
              AND lease_expires_at > now()
          `,
          [job.id, job.lease_token, leaseSeconds],
        )
        .catch(() => {});
    }, 30000);

    heartbeat.unref();

    try {
      await this.importArtifact(job);
    } catch (error) {
      await this.recordFailure(job, error);
    } finally {
      clearInterval(heartbeat);
    }

    return true;
  }

  private async importArtifact(job: ImportJob) {
    const connection = await this.integrations.load(job.organisation_id, job.connection_id);

    if (!connection.enabled) {
      throw new ProviderError(
        'CONNECTION_DISABLED',
        'This connection is disabled. Enable it before retrying.',
      );
    }

    const adapter = this.integrations.adapter(connection);
    const reference = adapterConnection(connection);
    const run = await adapter.getRun(reference, job.run_id);

    if (
      run.repositoryId !== connection.repository_id ||
      run.headRepositoryId !== connection.repository_id ||
      run.pipelineId !== connection.workflow_id ||
      run.branch !== connection.branch ||
      !['push', 'workflow_dispatch', 'schedule', 'release'].includes(run.event)
    ) {
      throw new ProviderError(
        'RUN_NOT_TRUSTED',
        'The run does not match this connection’s repository, workflow, branch and event policy.',
      );
    }

    if (run.attempt !== job.run_attempt) {
      throw new ProviderError(
        'RUN_ATTEMPT_CHANGED',
        'A newer run attempt exists. Import the current attempt instead.',
      );
    }

    if (run.status === 'queued' || run.status === 'running') {
      throw new ProviderError(
        'RUN_NOT_COMPLETE',
        'The GitHub run has not completed. The import will retry.',
        true,
      );
    }

    if (run.status !== 'succeeded') {
      throw new ProviderError(
        'RUN_NOT_SUCCESSFUL',
        'Only successful GitHub workflow runs can supply release artifacts.',
      );
    }

    const artifacts = await adapter.listArtifacts(reference, job.run_id);

    const matching = artifacts.filter(
      (artifact) =>
        artifact.name === connection.artifact_name &&
        Date.parse(artifact.created_at) >= Date.parse(run.startedAt),
    );

    if (matching.length !== 1) {
      throw new ProviderError(
        'ARTIFACT_SELECTION_FAILED',
        'The current attempt must contain exactly one artifact matching the configured name.',
      );
    }

    const artifact = matching[0];

    if (
      artifact.expired ||
      (artifact.expires_at && Date.parse(artifact.expires_at) <= Date.now())
    ) {
      throw new ProviderError(
        'ARTIFACT_EXPIRED',
        'This GitHub artifact has expired. Publish a new build.',
      );
    }

    if (
      artifact.workflow_run.id !== run.id ||
      artifact.workflow_run.head_sha !== run.commit ||
      artifact.workflow_run.repository_id !== connection.repository_id ||
      artifact.workflow_run.head_repository_id !== connection.repository_id
    ) {
      throw new ProviderError(
        'ARTIFACT_RUN_MISMATCH',
        'The artifact metadata does not match the verified run.',
      );
    }

    if (!artifact.digest || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
      throw new ProviderError(
        'ARTIFACT_DIGEST_REQUIRED',
        'GitHub must supply a SHA-256 digest. Publish with a current upload-artifact action.',
      );
    }

    if (artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 25 * 1024 * 1024) {
      throw new ProviderError(
        'ARTIFACT_SIZE_LIMIT',
        'This artifact exceeds the 25 MiB import limit or is empty.',
      );
    }

    const bytes = await adapter.download(reference, artifact.id);
    const digest = artifact.digest.slice(7);

    if (sha256(bytes) !== digest) {
      throw new ProviderError(
        'DIGEST_MISMATCH',
        'The downloaded artifact does not match GitHub’s SHA-256 digest.',
      );
    }

    const currentRun = await adapter.getRun(reference, job.run_id);

    if (
      currentRun.attempt !== run.attempt ||
      currentRun.commit !== run.commit ||
      currentRun.status !== 'succeeded'
    ) {
      throw new ProviderError(
        'RUN_ATTEMPT_CHANGED',
        'The run changed during download. Import the current successful attempt.',
      );
    }

    // Write outside the final transaction. A lost lease may leave an unreferenced immutable blob.
    await this.integrations.control.store.put(job.organisation_id, digest, bytes);
    const tx = await this.db.connect();

    try {
      await tx.query('BEGIN');

      const lease = await tx.query(
        `
          SELECT
            1
          FROM
            artifact_imports
          WHERE
            id = $1
            AND lease_token = $2
            AND status = 'processing'
            AND lease_expires_at > clock_timestamp()
          FOR UPDATE
        `,
        [job.id, job.lease_token],
      );

      if (!lease.rowCount) {
        await tx.query('ROLLBACK');

        return;
      }

      const current = await tx.query(
        `
          SELECT
            1
          FROM
            provider_connections
          WHERE
            organisation_id = $1
            AND id = $2
            AND enabled = TRUE
            AND credential_revision = $3
          FOR SHARE
        `,
        [job.organisation_id, connection.id, connection.credential_revision],
      );

      if (!current.rowCount) {
        throw new ProviderError(
          'CONNECTION_CHANGED',
          'The connection changed during import. The import will retry.',
          true,
        );
      }

      const principal: Principal = {
        organisation_id: job.organisation_id,
        actor_id: job.requested_by,
        name: 'Artifact import worker',
        permissions: ['read', 'write'],
      };

      const retained = await this.integrations.control.artifact(
        tx,
        principal,
        {
          project_id: job.project_id,
          name: connection.artifact_name,
          version: `gh-${run.id}.${run.attempt}.${artifact.id}`,
          digest,
        },
        bytes,
        {
          source: 'github-actions',
          connection_id: connection.id,
          repository: connection.repository,
          repository_id: connection.repository_id,
          workflow_id: run.pipelineId,
          run_id: run.id,
          run_attempt: run.attempt,
          run_url: run.url,
          original_status: run.originalStatus,
          commit: run.commit,
          branch: run.branch,
          artifact_id: artifact.id,
          provider_digest: artifact.digest,
          archive_format: 'zip',
        },
      );

      await tx.query(
        `
          UPDATE artifact_imports
          SET
            status = 'succeeded',
            artifact_id = $3,
            lease_token = NULL,
            lease_expires_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
          WHERE
            id = $1
            AND lease_token = $2
        `,
        [job.id, job.lease_token, retained.id],
      );

      await this.integrations.control.audit(tx, principal, 'artifact.imported', retained.id, {
        import_id: job.id,
        connection_id: connection.id,
        run_id: run.id,
        digest,
      });

      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }

  private async recordFailure(job: ImportJob, error: unknown) {
    let code = 'IMPORT_FAILED';
    let message = 'The import could not be completed. Retry it or check the worker configuration.';
    let retryable = false;
    let retryAfter = 0;

    if (error instanceof DomainError) {
      code = error.code;
      message = error.message;
      retryable = error.status >= 500;
    }

    if (error instanceof ProviderError) {
      retryable = error.retryable;
      retryAfter = error.retryAfterSeconds;
    }

    const retry = retryable && job.attempts < maximumAttempts;
    const delay = Math.max(retryAfter, Math.min(300, 5 * 2 ** (job.attempts - 1)));

    await this.db.query(
      `
        UPDATE artifact_imports
        SET
          status = $3,
          available_at = now() + ($4 * interval '1 second'),
          lease_token = NULL,
          lease_expires_at = NULL,
          error_code = $5,
          error_message = $6,
          updated_at = now()
        WHERE
          id = $1
          AND lease_token = $2
          AND status = 'processing'
      `,
      [job.id, job.lease_token, retry ? 'pending' : 'failed', delay, code, message],
    );
  }
}
