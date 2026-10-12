import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Transaction } from '../../../packages/database/src/index.js';
import {
  DomainError,
  type Deployment,
  type Environment,
  type Principal,
  type Release,
} from '../../../packages/domain/src/index.js';
import {
  parseProcess,
  requiresApproval,
  supportsDockerRecreate,
} from '../../../packages/deployment-schema/src/index.js';
import type { ControlPlane } from './control-plane.js';

export const rollbackPlanInput = z
  .object({
    source_deployment_id: z.string().uuid(),
    candidate_deployment_id: z.string().uuid(),
  })
  .strict();

export const rollbackRequestInput = z
  .object({
    acknowledge_data_not_restored: z.literal(true),
  })
  .strict();

interface Source extends Deployment {
  target_id: string;
  fence: number;
}

interface Plan {
  id: string;
  organisation_id: string;
  source_deployment_id: string;
  candidate_deployment_id: string;
  release_id: string;
  target_id: string;
  expected_fence: number;
  policy_revision: number;
  expires_at: string;
  expired: boolean;
  secret_bindings: { variable: string; name: string; version: number }[];
}

export class RollbackService {
  constructor(private control: ControlPlane) {}

  private async source(tx: Transaction, org: string, id: string) {
    const source = (
      await tx.query<Source>(
        `
          SELECT
            d.*,
            a.target_id,
            a.fence
          FROM
            deployments d
            JOIN deployment_attempts a ON a.organisation_id = d.organisation_id
            AND a.deployment_id = d.id
          WHERE
            d.organisation_id = $1
            AND d.id = $2
            AND d.status IN ('succeeded', 'failed', 'cancelled')
            AND a.state IN ('succeeded', 'failed', 'cancelled')
            AND a.fence > 0
        `,
        [org, id],
      )
    ).rows[0];

    if (!source) {
      throw new DomainError(
        'ROLLBACK_UNAVAILABLE',
        'Choose a finished deployment that reached a Docker target. Interrupted work must finish cleanup first.',
        409,
      );
    }

    return source;
  }

  private async target(tx: Transaction, org: string, source: Source) {
    const target = (
      await tx.query(
        'SELECT * FROM deployment_targets WHERE organisation_id=$1 AND id=$2 FOR UPDATE',
        [org, source.target_id],
      )
    ).rows[0];

    if (!target || target.fence !== source.fence) {
      throw new DomainError(
        'STALE_ROLLBACK',
        'A newer attempt changed this target. Plan from its latest finished deployment.',
        409,
      );
    }

    const active = await tx.query(
      `
        SELECT
          id
        FROM
          deployments
        WHERE
          organisation_id = $1
          AND project_id = $2
          AND environment_id = $3
          AND status IN (
            'awaiting_approval',
            'queued',
            'running',
            'cancel_requested',
            'reconciliation_required'
          )
        LIMIT
          1
      `,
      [org, source.project_id, source.environment_id],
    );

    if (active.rowCount) {
      throw new DomainError(
        'ENVIRONMENT_LOCKED',
        'Finish or cancel the outstanding deployment and complete cleanup before planning a rollback.',
        409,
      );
    }

    return target;
  }

  async candidates(tx: Transaction, org: string, sourceId: string) {
    const source = await this.source(tx, org, sourceId);

    await this.target(tx, org, source);

    // One entry per previously verified release, including history outside the dashboard's window.
    const result = await tx.query(
      `
        SELECT
          *
        FROM
          (
            SELECT DISTINCT
              ON (d.release_id) d.id AS deployment_id,
              d.release_id,
              r.version,
              r.manifest -> 'artifact' ->> 'digest' AS digest,
              d.updated_at AS verified_at,
              a.fence
            FROM
              deployments d
              JOIN deployment_attempts a ON a.organisation_id = d.organisation_id
              AND a.deployment_id = d.id
              JOIN releases r ON r.organisation_id = d.organisation_id
              AND r.id = d.release_id
            WHERE
              d.organisation_id = $1
              AND d.project_id = $2
              AND d.environment_id = $3
              AND a.target_id = $4
              AND d.status = 'succeeded'
              AND d.result_code = 'HTTP_VERIFIED'
              AND a.state = 'succeeded'
              AND a.result_code = 'HTTP_VERIFIED'
              AND a.fence > 0
              AND a.fence < $5
              AND d.release_id <> $6
            ORDER BY
              d.release_id,
              a.fence DESC
          ) history
        ORDER BY
          fence DESC
        LIMIT
          50
      `,
      [
        org,
        source.project_id,
        source.environment_id,
        source.target_id,
        source.fence,
        source.release_id,
      ],
    );

    return { source_deployment_id: source.id, candidates: result.rows };
  }

  private async preflight(tx: Transaction, org: string, source: Source, candidateId: string) {
    // Use the same lock order as admission: environment, then target.
    const environment = (
      await tx.query<Environment>(
        'SELECT * FROM environments WHERE organisation_id=$1 AND id=$2 FOR SHARE',
        [org, source.environment_id],
      )
    ).rows[0];

    const target = await this.target(tx, org, source);

    const candidate = (
      await tx.query<Deployment>(
        `
          SELECT
            d.*
          FROM
            deployments d
            JOIN deployment_attempts a ON a.organisation_id = d.organisation_id
            AND a.deployment_id = d.id
          WHERE
            d.organisation_id = $1
            AND d.id = $2
            AND d.project_id = $3
            AND d.environment_id = $4
            AND a.target_id = $5
            AND d.status = 'succeeded'
            AND d.result_code = 'HTTP_VERIFIED'
            AND a.state = 'succeeded'
            AND a.result_code = 'HTTP_VERIFIED'
            AND a.fence > 0
            AND a.fence < $6
            AND d.release_id <> $7
        `,
        [
          org,
          candidateId,
          source.project_id,
          source.environment_id,
          source.target_id,
          source.fence,
          source.release_id,
        ],
      )
    ).rows[0];

    if (!candidate) {
      throw new DomainError(
        'INELIGIBLE_ROLLBACK',
        'Select an earlier release verified on this same target and environment.',
        409,
      );
    }

    const release = (
      await tx.query<Release>('SELECT * FROM releases WHERE organisation_id=$1 AND id=$2', [
        org,
        candidate.release_id,
      ])
    ).rows[0];

    const process = parseProcess(release.manifest.process);
    const config = process.spec.environments[environment.slug];

    if (!supportsDockerRecreate(process, config)) {
      throw new DomainError(
        'UNSUPPORTED_PROCESS',
        'This retained release does not support the Docker recreate executor.',
        409,
      );
    }

    const matches = await tx.query(
      `
        SELECT
          t.id,
          a.name AS agent_name
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
      `,
      [org, source.project_id, source.environment_id, JSON.stringify(config.targetSelector.labels)],
    );

    if (matches.rowCount !== 1 || matches.rows[0].id !== target.id) {
      throw new DomainError(
        'ROLLBACK_TARGET_UNAVAILABLE',
        'The retained process must select this target alone, with its agent active.',
        409,
      );
    }

    await this.control.store.get(org, release.manifest.artifact.digest);
    const evidence = await this.control.delivery.evidence(tx, org, release, environment);

    const secrets = await this.control.secrets.resolve(
      tx,
      org,
      source.project_id,
      environment.id,
      config.secrets,
    );

    return {
      environment,
      target,
      candidate,
      release,
      config,
      evidence,
      secrets: secrets.map(({ variable, secret }) => ({
        variable,
        name: secret.name,
        version: secret.current_version,
      })),
      agentName: matches.rows[0].agent_name,
    };
  }

  async create(tx: Transaction, p: Principal, input: z.infer<typeof rollbackPlanInput>) {
    const source = await this.source(tx, p.organisation_id, input.source_deployment_id);

    const checked = await this.preflight(
      tx,
      p.organisation_id,
      source,
      input.candidate_deployment_id,
    );

    const { environment, target, release } = checked;

    const plan = (
      await tx.query<Plan>(
        `
          INSERT INTO
            rollback_plans (
              id,
              organisation_id,
              project_id,
              environment_id,
              source_deployment_id,
              candidate_deployment_id,
              release_id,
              target_id,
              expected_fence,
              policy_revision,
              secret_bindings,
              created_by
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING
            *
        `,
        [
          randomUUID(),
          p.organisation_id,
          source.project_id,
          environment.id,
          source.id,
          checked.candidate.id,
          release.id,
          target.id,
          source.fence,
          environment.policy_revision,
          JSON.stringify(checked.secrets),
          p.actor_id,
        ],
      )
    ).rows[0];

    await this.control.audit(tx, p, 'rollback.planned', plan.id, {
      source_deployment_id: source.id,
      candidate_deployment_id: checked.candidate.id,
      release_id: release.id,
      target_id: target.id,
      expected_fence: source.fence,
      digest: release.manifest.artifact.digest,
    });

    return {
      ...plan,
      release_version: release.version,
      digest: release.manifest.artifact.digest,
      target_name: target.name,
      agent_name: checked.agentName,
      environment_name: environment.name,
      requires_approval: requiresApproval(environment, checked.config),
      promotion_source_deployment_id: checked.evidence,
      strategy: 'recreate',
      health_path: checked.config.verify.http.path,
      warning:
        'This redeploys application code and causes downtime. It does not restore databases, undo migrations or reverse external side effects. Check compatibility before proceeding.',
    };
  }

  async request(tx: Transaction, p: Principal, id: string) {
    const plan = (
      await tx.query<Plan>(
        `
          SELECT
            *,
            expires_at <= clock_timestamp() AS expired
          FROM
            rollback_plans
          WHERE
            organisation_id = $1
            AND id = $2
          FOR UPDATE
        `,
        [p.organisation_id, id],
      )
    ).rows[0];

    if (!plan) {
      throw new DomainError('NOT_FOUND', 'Rollback plan not found.', 404);
    }

    if (plan.expired) {
      throw new DomainError('PLAN_EXPIRED', 'This rollback plan expired. Create a new plan.', 409);
    }

    const used = await tx.query(
      'SELECT id FROM deployments WHERE organisation_id=$1 AND rollback_plan_id=$2',
      [p.organisation_id, id],
    );

    if (used.rowCount) {
      throw new DomainError('PLAN_USED', 'This plan already has a deployment request.', 409);
    }

    const source = await this.source(tx, p.organisation_id, plan.source_deployment_id);

    const checked = await this.preflight(
      tx,
      p.organisation_id,
      source,
      plan.candidate_deployment_id,
    );

    if (
      checked.environment.policy_revision !== plan.policy_revision ||
      checked.target.id !== plan.target_id ||
      checked.target.fence !== plan.expected_fence ||
      checked.release.id !== plan.release_id ||
      !isDeepStrictEqual(checked.secrets, plan.secret_bindings)
    ) {
      throw new DomainError(
        'STALE_ROLLBACK',
        'The target, policy or secret versions changed. Review a new rollback plan.',
        409,
      );
    }

    const deployment = await this.control.deploy(
      tx,
      p,
      {
        release_id: plan.release_id,
        environment_id: checked.environment.id,
      },
      plan.id,
    );

    await this.control.audit(tx, p, 'rollback.requested', deployment.id, {
      plan_id: plan.id,
      source_deployment_id: plan.source_deployment_id,
      acknowledge_data_not_restored: true,
    });

    return deployment;
  }
}
