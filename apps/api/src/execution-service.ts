import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { transaction, type Transaction } from '../../../packages/database/src/index.js';
import {
  DomainError,
  type Deployment,
  type Principal,
} from '../../../packages/domain/src/index.js';
import {
  parseProcess,
  supportsDockerRecreate,
} from '../../../packages/deployment-schema/src/index.js';
import { ControlPlane } from './control-plane.js';
import { sha256 } from './artifact-store.js';

const uuid = z.string().uuid();

export const agentInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    certificate_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const targetInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    project_id: uuid,
    environment_id: uuid,
    agent_id: uuid,
    capability: z.enum(['docker-recreate-v1', 'ssh-docker-recreate-v1']).optional(),
    labels: z
      .record(z.string().min(1).max(100), z.string().min(1).max(100))
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 20),
  })
  .strict();

export const leaseInput = z
  .object({
    attempt_id: uuid,
    fence: z.number().int().positive(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const resultInput = leaseInput
  .extend({
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    code: z.enum([
      'HTTP_VERIFIED',
      'DOCKER_FAILED',
      'HEALTH_FAILED',
      'ARTIFACT_INVALID',
      'SECRET_UNAVAILABLE',
      'CANCELLED',
      'RECONCILED',
      'TARGET_NOT_ALLOWED',
    ]),
  })
  .strict();

export const certificateInput = z
  .object({
    certificate_fingerprint: agentInput.shape.certificate_fingerprint,
    same_host_agent_stopped: z.literal(true),
  })
  .strict();

export const progressInput = leaseInput
  .extend({
    phase: z.enum([
      'downloading',
      'loading_image',
      'replacing_container',
      'verifying_http',
      'cleaning_up',
    ]),
  })
  .strict();

export interface AgentIdentity {
  id: string;
  organisation_id: string;
  state: string;
  certificate_fingerprint: string;
}

export type Lease = z.infer<typeof leaseInput>;

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);

export class ExecutionService {
  constructor(public control: ControlPlane) {}

  async registerAgent(tx: Transaction, p: Principal, input: z.infer<typeof agentInput>) {
    const result = await tx.query(
      `
        INSERT INTO
          deployment_agents (
            id,
            organisation_id,
            name,
            certificate_fingerprint
          )
        VALUES
          ($1, $2, $3, $4)
        RETURNING
          *
      `,
      [randomUUID(), p.organisation_id, input.name, input.certificate_fingerprint],
    );

    await tx.query(
      `
        INSERT INTO
          agent_certificates (fingerprint, organisation_id, agent_id)
        VALUES
          ($1, $2, $3)
      `,
      [input.certificate_fingerprint, p.organisation_id, result.rows[0].id],
    );

    await this.control.audit(tx, p, 'agent.registered', result.rows[0].id);

    return result.rows[0];
  }

  async replaceCertificate(
    tx: Transaction,
    p: Principal,
    id: string,
    input: z.infer<typeof certificateInput>,
  ) {
    const current = (
      await tx.query(
        'SELECT * FROM deployment_agents WHERE organisation_id=$1 AND id=$2 FOR UPDATE',
        [p.organisation_id, uuid.parse(id)],
      )
    ).rows[0];

    if (!current) {
      throw new DomainError('NOT_FOUND', 'Agent not found.', 404);
    }

    if (current.state === 'active') {
      throw new DomainError(
        'AGENT_BUSY',
        'Drain or revoke the agent before replacing its certificate.',
        409,
      );
    }

    const running = await tx.query(
      `
        SELECT
          1
        FROM
          deployment_attempts
        WHERE
          organisation_id = $1
          AND agent_id = $2
          AND state IN ('running', 'reconciling')
        LIMIT
          1
      `,
      [p.organisation_id, id],
    );

    if (running.rowCount) {
      throw new DomainError(
        'AGENT_BUSY',
        'Wait for active work to finish or enter reconciliation before replacing the certificate.',
        409,
      );
    }

    // Retain every fingerprint permanently so a retired certificate cannot be re-enrolled.
    await tx.query(
      `
        INSERT INTO
          agent_certificates (fingerprint, organisation_id, agent_id)
        VALUES
          ($1, $2, $3)
      `,
      [input.certificate_fingerprint, p.organisation_id, id],
    );

    const updated = await tx.query(
      `
        UPDATE deployment_agents
        SET
          certificate_fingerprint = $3,
          state = 'draining',
          last_seen_at = NULL
        WHERE
          organisation_id = $1
          AND id = $2
        RETURNING
          *
      `,
      [p.organisation_id, id, input.certificate_fingerprint],
    );

    await this.control.audit(tx, p, 'agent.certificate_replaced', id, {
      previous_fingerprint: current.certificate_fingerprint,
      certificate_fingerprint: input.certificate_fingerprint,
      same_host_agent_stopped: input.same_host_agent_stopped,
    });

    return updated.rows[0];
  }

  async agentState(tx: Transaction, p: Principal, id: string, state: string) {
    await tx.query(
      'SELECT id FROM deployment_agents WHERE organisation_id=$1 AND id=$2 FOR UPDATE',
      [p.organisation_id, uuid.parse(id)],
    );

    if (state === 'active') {
      const pending = await tx.query(
        `
          SELECT
            1
          FROM
            deployment_attempts
          WHERE
            organisation_id = $1
            AND agent_id = $2
            AND state IN ('reconciliation_required', 'reconciling')
          LIMIT
            1
        `,
        [p.organisation_id, id],
      );

      if (pending.rowCount) {
        throw new DomainError(
          'RECOVERY_PENDING',
          'The agent must confirm target cleanup before resuming deployments.',
          409,
        );
      }
    }

    const result = await tx.query(
      `
        UPDATE deployment_agents
        SET
          state = $3
        WHERE
          organisation_id = $1
          AND id = $2
          AND state <> 'revoked'
        RETURNING
          *
      `,
      [p.organisation_id, uuid.parse(id), state],
    );

    if (!result.rowCount) {
      throw new DomainError('NOT_FOUND', 'Active agent not found.', 404);
    }

    await this.control.audit(tx, p, `agent.${state}`, id);

    return result.rows[0];
  }

  async registerTarget(tx: Transaction, p: Principal, input: z.infer<typeof targetInput>) {
    const valid = await tx.query(
      `
        SELECT
          1
        FROM
          projects p,
          environments e,
          deployment_agents a
        WHERE
          p.organisation_id = $1
          AND p.id = $2
          AND e.organisation_id = $1
          AND e.id = $3
          AND a.organisation_id = $1
          AND a.id = $4
          AND a.state = 'active'
      `,
      [p.organisation_id, input.project_id, input.environment_id, input.agent_id],
    );

    if (!valid.rowCount) {
      throw new DomainError('NOT_FOUND', 'Project, environment or active agent not found.', 404);
    }

    const result = await tx.query(
      `
        INSERT INTO
          deployment_targets (
            id,
            organisation_id,
            project_id,
            environment_id,
            agent_id,
            name,
            labels,
            capability
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          *
      `,
      [
        randomUUID(),
        p.organisation_id,
        input.project_id,
        input.environment_id,
        input.agent_id,
        input.name,
        input.labels,
        input.capability ?? 'docker-recreate-v1',
      ],
    );

    await this.control.audit(tx, p, 'target.registered', result.rows[0].id);

    return result.rows[0];
  }

  async authenticate(fingerprint: string): Promise<AgentIdentity> {
    const result = await this.control.db.query(
      `
        UPDATE deployment_agents
        SET
          last_seen_at = clock_timestamp()
        WHERE
          certificate_fingerprint = $1
          AND state <> 'revoked'
        RETURNING
          id,
          organisation_id,
          state,
          certificate_fingerprint
      `,
      [fingerprint],
    );

    if (!result.rowCount) {
      throw new DomainError(
        'AGENT_UNAUTHENTICATED',
        'Agent certificate is not registered or has been revoked.',
        401,
      );
    }

    return result.rows[0];
  }

  async event(
    tx: Transaction,
    d: Deployment,
    status: Deployment['status'],
    code: string | null = null,
  ) {
    const updated = (
      await tx.query<Deployment>(
        `
          UPDATE deployments
          SET
            status = $3,
            result_code = $4,
            updated_at = clock_timestamp()
          WHERE
            organisation_id = $1
            AND id = $2
          RETURNING
            *
        `,
        [d.organisation_id, d.id, status, code],
      )
    ).rows[0];

    const attempt = (
      await tx.query(
        `
          SELECT
            id,
            target_id,
            agent_id,
            fence
          FROM
            deployment_attempts
          WHERE
            organisation_id = $1
            AND deployment_id = $2
        `,
        [d.organisation_id, d.id],
      )
    ).rows[0];

    await this.control.deploymentEvent(
      tx,
      {
        organisation_id: d.organisation_id,
        actor_id: d.requested_by,
        name: 'Deployment workflow',
        permissions: [],
      },
      updated,
      { origin: 'deployment-workflow', result_code: code, attempt: attempt ?? null },
    );
  }

  // Temporal retries this transaction. Assignment and state transitions are idempotent.
  async tick(org: string, id: string): Promise<boolean> {
    return transaction(this.control.db, async (tx) => {
      const d = (
        await tx.query<Deployment & { queue_expired: boolean }>(
          `
            SELECT
              *,
              updated_at < clock_timestamp() - interval '5 minutes' AS queue_expired
            FROM
              deployments
            WHERE
              organisation_id = $1
              AND id = $2
            FOR UPDATE
          `,
          [org, id],
        )
      ).rows[0];

      if (!d) {
        return true;
      }

      const attempt = (
        await tx.query(
          `
            SELECT
              *,
              lease_expires_at <= clock_timestamp() AS expired,
              deadline_at <= clock_timestamp() AS overdue,
              created_at < clock_timestamp() - interval '5 minutes' AS unclaimed_expired
            FROM
              deployment_attempts
            WHERE
              organisation_id = $1
              AND deployment_id = $2
            FOR UPDATE
          `,
          [org, id],
        )
      ).rows[0];

      if (attempt) {
        if (attempt.state === 'ready' && d.status === 'queued' && attempt.unclaimed_expired) {
          await tx.query(
            `
              UPDATE deployment_attempts
              SET
                state = 'failed',
                result_code = 'AGENT_UNAVAILABLE',
                updated_at = clock_timestamp()
              WHERE
                id = $1
            `,
            [attempt.id],
          );

          await this.event(tx, d, 'failed', 'AGENT_UNAVAILABLE');

          return true;
        }

        if (terminal.has(d.status) && attempt.state === 'ready') {
          await tx.query(
            `
              UPDATE deployment_attempts
              SET
                state = 'cancelled',
                updated_at = clock_timestamp()
              WHERE
                id = $1
            `,
            [attempt.id],
          );
        } else if (
          ['running', 'reconciling'].includes(attempt.state) &&
          (attempt.expired || attempt.overdue)
        ) {
          await tx.query(
            `
              UPDATE deployment_attempts
              SET
                state = 'reconciliation_required',
                lease_hash = NULL,
                updated_at = clock_timestamp()
              WHERE
                id = $1
            `,
            [attempt.id],
          );

          if (d.status !== 'cancel_requested') {
            await this.event(tx, d, 'reconciliation_required', 'LEASE_EXPIRED');
          }
        }

        return terminal.has(d.status);
      }

      if (d.status !== 'queued') {
        return terminal.has(d.status);
      }

      const release = (
        await tx.query('SELECT manifest FROM releases WHERE organisation_id=$1 AND id=$2', [
          org,
          d.release_id,
        ])
      ).rows[0];

      const env = (
        await tx.query('SELECT slug FROM environments WHERE organisation_id=$1 AND id=$2', [
          org,
          d.environment_id,
        ])
      ).rows[0];

      const process = parseProcess(release.manifest.process);
      const config = process.spec.environments[env.slug];

      if (!supportsDockerRecreate(process, config)) {
        await this.event(tx, d, 'failed', 'UNSUPPORTED_PROCESS');

        return true;
      }

      const targets = await tx.query(
        `
          SELECT
            t.*
          FROM
            deployment_targets t
            JOIN deployment_agents a ON a.organisation_id = t.organisation_id
            AND a.id = t.agent_id
          WHERE
            t.organisation_id = $1
            AND t.project_id = $2
            AND t.environment_id = $3
            AND t.labels @> $4::jsonb
            AND a.state = 'active'
          ORDER BY
            t.id
          FOR UPDATE OF
            t
        `,
        [org, d.project_id, d.environment_id, JSON.stringify(config.targetSelector.labels)],
      );

      if (targets.rowCount !== 1) {
        if (targets.rowCount && targets.rowCount > 1) {
          await this.event(tx, d, 'failed', 'AMBIGUOUS_TARGET');

          return true;
        }

        if (d.queue_expired) {
          await this.event(tx, d, 'failed', 'NO_TARGET');

          return true;
        }

        return false;
      }

      const target = targets.rows[0];

      if (d.rollback_plan_id) {
        const plan = (
          await tx.query(
            `
              SELECT
                target_id,
                expected_fence
              FROM
                rollback_plans
              WHERE
                organisation_id = $1
                AND id = $2
            `,
            [org, d.rollback_plan_id],
          )
        ).rows[0];

        if (!plan || plan.target_id !== target.id || plan.expected_fence !== target.fence) {
          await this.event(tx, d, 'failed', 'ROLLBACK_TARGET_CHANGED');

          return true;
        }
      }

      await tx.query(
        `
          INSERT INTO
            deployment_attempts (
              id,
              organisation_id,
              deployment_id,
              target_id,
              agent_id,
              state
            )
          VALUES
            ($1, $2, $3, $4, $5, 'ready')
          ON CONFLICT DO NOTHING
        `,
        [randomUUID(), org, id, target.id, target.agent_id],
      );

      // Bound waiting time even if the assigned agent never polls.
      return false;
    });
  }

  async claim(agent: AgentIdentity, supportsSecrets = false, supportsSSH = false) {
    return transaction(this.control.db, async (tx) => {
      await this.lockAgent(tx, agent);

      // Lock deployment before attempt everywhere, including cancellation and completion.
      const candidates = await tx.query(
        `
          SELECT
            d.*
          FROM
            deployments d
            JOIN deployment_attempts a ON a.organisation_id = d.organisation_id
            AND a.deployment_id = d.id
          WHERE
            a.organisation_id = $1
            AND a.agent_id = $2
            AND (
              $5::boolean
              OR EXISTS (
                SELECT
                  1
                FROM
                  deployment_targets t
                WHERE
                  t.organisation_id = a.organisation_id
                  AND t.id = a.target_id
                  AND t.capability = 'docker-recreate-v1'
              )
            )
            AND (
              a.state = 'reconciliation_required'
              OR (
                a.state = 'ready'
                AND d.status = 'queued'
                AND $3 = 'active'
                AND (
                  $4::boolean
                  OR NOT EXISTS (
                    SELECT
                      1
                    FROM
                      deployment_secret_bindings b
                    WHERE
                      b.organisation_id = d.organisation_id
                      AND b.deployment_id = d.id
                  )
                )
              )
            )
          ORDER BY
            a.created_at
          LIMIT
            1
          FOR UPDATE OF
            d SKIP LOCKED
        `,
        [agent.organisation_id, agent.id, agent.state, supportsSecrets, supportsSSH],
      );

      const d = candidates.rows[0] as Deployment | undefined;

      if (!d) {
        return null;
      }

      const a = (
        await tx.query(
          `
            SELECT
              *
            FROM
              deployment_attempts
            WHERE
              organisation_id = $1
              AND deployment_id = $2
            FOR UPDATE
          `,
          [agent.organisation_id, d.id],
        )
      ).rows[0];

      const cleanup = a.state === 'reconciliation_required';
      const token = randomBytes(32).toString('hex');

      const targetFence = (
        await tx.query(
          `
            UPDATE deployment_targets
            SET
              fence = fence + 1
            WHERE
              organisation_id = $1
              AND id = $2
            RETURNING
              fence,
              capability
          `,
          [agent.organisation_id, a.target_id],
        )
      ).rows[0];

      const lease = (
        await tx.query(
          `
            UPDATE deployment_attempts
            SET
              state = $2,
              fence = $4,
              lease_hash = $3,
              lease_expires_at = clock_timestamp() + interval '45 seconds',
              deadline_at = clock_timestamp() + interval '10 minutes',
              updated_at = clock_timestamp()
            WHERE
              id = $1
            RETURNING
              fence
          `,
          [a.id, cleanup ? 'reconciling' : 'running', sha256(token), targetFence.fence],
        )
      ).rows[0];

      await tx.query(
        `
          UPDATE deployment_targets
          SET
            current_release_id = NULL,
            current_state = 'unknown'
          WHERE
            organisation_id = $1
            AND id = $2
        `,
        [agent.organisation_id, a.target_id],
      );

      if (!cleanup) {
        await this.event(tx, d, 'running');
      }

      const release = (
        await tx.query('SELECT manifest FROM releases WHERE organisation_id=$1 AND id=$2', [
          agent.organisation_id,
          d.release_id,
        ])
      ).rows[0];

      const env = (
        await tx.query('SELECT slug FROM environments WHERE organisation_id=$1 AND id=$2', [
          agent.organisation_id,
          d.environment_id,
        ])
      ).rows[0];

      const process = parseProcess(release.manifest.process);

      return {
        attempt_id: a.id,
        fence: lease.fence,
        token,
        mode: cleanup ? 'cleanup' : 'deploy',
        target_id: a.target_id,
        capability: targetFence.capability,
        digest: release.manifest.artifact.digest,
        size: release.manifest.artifact.size,
        image_id: process.spec.artifact.dockerImageId,
        archive_path: process.spec.artifact.dockerArchivePath ?? '',
        health_path: process.spec.environments[env.slug].verify?.http.path,
        secret_count: cleanup
          ? 0
          : Object.keys(process.spec.environments[env.slug].secrets ?? {}).length,
      };
    });
  }

  async lockAgent(tx: Transaction, agent: AgentIdentity) {
    const current = (
      await tx.query(
        `
          SELECT
            state,
            certificate_fingerprint
          FROM
            deployment_agents
          WHERE
            organisation_id = $1
            AND id = $2
          FOR UPDATE
        `,
        [agent.organisation_id, agent.id],
      )
    ).rows[0];

    if (
      !current ||
      current.state === 'revoked' ||
      current.certificate_fingerprint !== agent.certificate_fingerprint
    ) {
      throw new DomainError(
        'AGENT_UNAUTHENTICATED',
        'Agent certificate is revoked or has been replaced.',
        401,
      );
    }

    agent.state = current.state;
  }

  async lockedLease(tx: Transaction, agent: AgentIdentity, input: Lease) {
    await this.lockAgent(tx, agent);

    const d = (
      await tx.query<Deployment>(
        `
          SELECT
            d.*
          FROM
            deployments d
            JOIN deployment_attempts a ON a.organisation_id = d.organisation_id
            AND a.deployment_id = d.id
          WHERE
            a.organisation_id = $1
            AND a.agent_id = $2
            AND a.id = $3
          FOR UPDATE OF
            d
        `,
        [agent.organisation_id, agent.id, input.attempt_id],
      )
    ).rows[0];

    const a = (
      await tx.query(
        `
          SELECT
            *
          FROM
            deployment_attempts
          WHERE
            organisation_id = $1
            AND agent_id = $2
            AND id = $3
            AND fence = $4
            AND lease_hash = $5
            AND lease_expires_at > clock_timestamp()
            AND deadline_at > clock_timestamp()
            AND state IN ('running', 'reconciling')
          FOR UPDATE
        `,
        [agent.organisation_id, agent.id, input.attempt_id, input.fence, sha256(input.token)],
      )
    ).rows[0];

    if (!d || !a || terminal.has(d.status)) {
      throw new DomainError('STALE_LEASE', 'The lease has expired or been superseded.', 409);
    }

    return { d, a };
  }

  async progress(agent: AgentIdentity, input: z.infer<typeof progressInput>) {
    return transaction(this.control.db, async (tx) => {
      const { d, a } = await this.lockedLease(tx, agent, input);

      if (
        (a.state === 'reconciling' || d.status === 'cancel_requested') &&
        input.phase !== 'cleaning_up'
      ) {
        throw new DomainError(
          'INVALID_PROGRESS',
          'Only cleanup progress is accepted during recovery.',
          409,
        );
      }

      await tx.query(
        `
          UPDATE deployment_attempts
          SET
            phase = $2,
            phase_updated_at = clock_timestamp()
          WHERE
            id = $1
            AND phase <> $2
        `,
        [a.id, input.phase],
      );

      return { accepted: true };
    });
  }

  async heartbeat(agent: AgentIdentity, input: Lease) {
    return transaction(this.control.db, async (tx) => {
      const { d, a } = await this.lockedLease(tx, agent, input);

      await tx.query(
        `
          UPDATE deployment_attempts
          SET
            lease_expires_at = LEAST(
              clock_timestamp() + interval '45 seconds',
              deadline_at
            ),
            updated_at = clock_timestamp()
          WHERE
            id = $1
        `,
        [a.id],
      );

      return {
        action:
          d.status === 'cancel_requested' || a.state === 'reconciling' ? 'cleanup' : 'continue',
      };
    });
  }

  async download(agent: AgentIdentity, input: Lease) {
    const digest = await transaction(this.control.db, async (tx) => {
      const { d, a } = await this.lockedLease(tx, agent, input);

      if (d.status !== 'running' || a.state !== 'running') {
        throw new DomainError('STALE_LEASE', 'This lease cannot download an artifact.', 409);
      }

      return (
        await tx.query('SELECT manifest FROM releases WHERE organisation_id=$1 AND id=$2', [
          agent.organisation_id,
          d.release_id,
        ])
      ).rows[0].manifest.artifact.digest as string;
    });

    return this.control.store.get(agent.organisation_id, digest);
  }

  async secrets(agent: AgentIdentity, input: Lease) {
    return transaction(this.control.db, async (tx) => {
      const { d, a } = await this.lockedLease(tx, agent, input);

      if (d.status !== 'running' || a.state !== 'running') {
        throw new DomainError('STALE_LEASE', 'This lease cannot retrieve deployment secrets.', 409);
      }

      return this.control.secrets.deliver(tx, d);
    });
  }

  async complete(agent: AgentIdentity, input: z.infer<typeof resultInput>) {
    return transaction(this.control.db, async (tx) => {
      const { d, a } = await this.lockedLease(tx, agent, input);

      if (
        input.outcome === 'succeeded' &&
        (d.status !== 'running' || a.state !== 'running' || input.code !== 'HTTP_VERIFIED')
      ) {
        throw new DomainError(
          'INVALID_RESULT',
          'Only an active verified deployment can succeed.',
          409,
        );
      }

      if (a.state === 'reconciling' && input.code !== 'RECONCILED') {
        throw new DomainError('INVALID_RESULT', 'Reconciliation must confirm target cleanup.', 409);
      }

      if (
        (input.outcome === 'succeeded') !== (input.code === 'HTTP_VERIFIED') ||
        (input.outcome === 'cancelled' && !['CANCELLED', 'RECONCILED'].includes(input.code))
      ) {
        throw new DomainError('INVALID_RESULT', 'Outcome and result code do not match.', 400);
      }

      const status = d.status === 'cancel_requested' ? 'cancelled' : input.outcome;

      if (status === 'succeeded') {
        await tx.query(
          `
            UPDATE deployment_targets
            SET
              current_release_id = $3,
              current_state = 'verified'
            WHERE
              organisation_id = $1
              AND id = $2
          `,
          [agent.organisation_id, a.target_id, d.release_id],
        );
      }

      await tx.query(
        `
          UPDATE deployment_attempts
          SET
            state = $2,
            result_code = $3,
            lease_hash = NULL,
            updated_at = clock_timestamp()
          WHERE
            id = $1
        `,
        [a.id, status, input.code],
      );

      await this.event(tx, d, status, input.code);

      return { status };
    });
  }
}
