import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Transaction } from '../../../packages/database/src/index.js';
import {
  DomainError,
  type Artifact,
  type Environment,
  type Principal,
  type RunbookRun,
} from '../../../packages/domain/src/index.js';
import {
  parseRunbook,
  type RunbookProcess,
} from '../../../packages/deployment-schema/src/index.js';
import type { ControlPlane } from './control-plane.js';

const uuid = z.string().uuid();

export const runbookInput = z
  .object({
    project_id: uuid,
    environment_id: uuid,
    name: z.string().trim().min(1).max(100),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    description: z.string().trim().max(500).default(''),
  })
  .strict();

export const runbookVersionInput = z
  .object({
    artifact_id: uuid,
    process: z.unknown(),
    expected_revision: z.number().int().min(0),
  })
  .strict();

export const runbookPlanInput = z
  .object({
    runbook_version_id: uuid,
    target_id: uuid,
  })
  .strict();

export const runbookAcknowledgement = z
  .object({
    acknowledge_external_effects: z.literal(true),
  })
  .strict();

interface Scope {
  organisation_id: string;
  project_id: string;
  environment_id: string;
}

export interface RunbookVersion extends Scope {
  id: string;
  runbook_id: string;
  version: number;
  manifest: {
    schema_version: 1;
    artifact: { id: string; name: string; digest: string; size: number };
    process: RunbookProcess;
  };
}

interface RunbookPlan extends Scope {
  id: string;
  runbook_version_id: string;
  target_id: string;
  expected_fence: number;
  policy_revision: number;
  requires_approval: boolean;
  secret_bindings: { variable: string; name: string; version: number }[];
  created_by: string;
  expired: boolean;
  restored: boolean;
  expires_at: string;
}

function assertScope(p: Principal, scope: Scope) {
  if (
    scope.organisation_id !== p.organisation_id ||
    (p.project_ids && !p.project_ids.includes(scope.project_id)) ||
    (p.environment_ids && !p.environment_ids.includes(scope.environment_id))
  ) {
    throw new DomainError('NOT_FOUND', 'Runbook not found.', 404);
  }
}

export class Runbooks {
  constructor(private control: ControlPlane) {}

  async create(tx: Transaction, p: Principal, input: z.infer<typeof runbookInput>) {
    assertScope(p, { organisation_id: p.organisation_id, ...input });
    await this.control.secrets.scope(tx, p.organisation_id, input.project_id, input.environment_id);

    const result = await tx.query(
      `
        INSERT INTO
          runbooks (
            id,
            organisation_id,
            project_id,
            environment_id,
            name,
            slug,
            description,
            created_by
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
        input.name,
        input.slug,
        input.description,
        p.actor_id,
      ],
    );

    await this.control.audit(tx, p, 'runbook.created', result.rows[0].id, {
      project_id: input.project_id,
      environment_id: input.environment_id,
      name: input.name,
    });

    return result.rows[0];
  }

  async publish(
    tx: Transaction,
    p: Principal,
    id: string,
    input: z.infer<typeof runbookVersionInput>,
  ) {
    const runbook = (
      await tx.query('SELECT * FROM runbooks WHERE organisation_id=$1 AND id=$2 FOR UPDATE', [
        p.organisation_id,
        id,
      ])
    ).rows[0];

    if (!runbook) {
      throw new DomainError('NOT_FOUND', 'Runbook not found.', 404);
    }

    assertScope(p, runbook);

    if (runbook.revision !== input.expected_revision) {
      throw new DomainError(
        'RUNBOOK_CHANGED',
        'Reload the runbook before publishing another version.',
        409,
      );
    }

    const artifact = (
      await tx.query<Artifact>(
        'SELECT * FROM artifacts WHERE organisation_id=$1 AND project_id=$2 AND id=$3',
        [p.organisation_id, runbook.project_id, input.artifact_id],
      )
    ).rows[0];

    if (!artifact) {
      throw new DomainError('NOT_FOUND', 'Artifact not found in this project.', 404);
    }

    const process = parseRunbook(input.process);

    await this.control.store.get(p.organisation_id, artifact.digest);

    const manifest = {
      schema_version: 1,
      artifact: {
        id: artifact.id,
        name: artifact.name,
        digest: artifact.digest,
        size: artifact.size,
      },
      process,
    };

    const result = await tx.query<RunbookVersion>(
      `
        INSERT INTO
          runbook_versions (
            id,
            organisation_id,
            project_id,
            environment_id,
            runbook_id,
            version,
            artifact_id,
            manifest,
            created_by
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
          *
      `,
      [
        randomUUID(),
        p.organisation_id,
        runbook.project_id,
        runbook.environment_id,
        id,
        runbook.revision + 1,
        artifact.id,
        manifest,
        p.actor_id,
      ],
    );

    await tx.query(
      'UPDATE runbooks SET revision=revision+1, updated_at=clock_timestamp() WHERE id=$1',
      [id],
    );

    await this.control.audit(tx, p, 'runbook.version_published', result.rows[0].id, {
      runbook_id: id,
      project_id: runbook.project_id,
      environment_id: runbook.environment_id,
      version: result.rows[0].version,
      digest: artifact.digest,
    });

    return result.rows[0];
  }

  async version(tx: Transaction, org: string, id: string): Promise<RunbookVersion> {
    const version = (
      await tx.query<RunbookVersion>(
        'SELECT * FROM runbook_versions WHERE organisation_id=$1 AND id=$2',
        [org, id],
      )
    ).rows[0];

    if (!version) {
      throw new DomainError('NOT_FOUND', 'Runbook version not found.', 404);
    }

    version.manifest.process = parseRunbook(version.manifest.process);

    return version;
  }

  private async preflight(tx: Transaction, p: Principal, versionId: string, targetId: string) {
    const version = await this.version(tx, p.organisation_id, versionId);

    assertScope(p, version);

    const environment = (
      await tx.query<Environment>(
        'SELECT * FROM environments WHERE organisation_id=$1 AND id=$2 FOR SHARE',
        [p.organisation_id, version.environment_id],
      )
    ).rows[0];

    const target = (
      await tx.query(
        `
          SELECT
            t.*,
            a.state AS agent_state,
            a.name AS agent_name
          FROM
            deployment_targets t
            JOIN deployment_agents a ON a.organisation_id = t.organisation_id
            AND a.id = t.agent_id
          WHERE
            t.organisation_id = $1
            AND t.project_id = $2
            AND t.environment_id = $3
            AND t.id = $4
          FOR UPDATE OF
            t
        `,
        [p.organisation_id, version.project_id, version.environment_id, targetId],
      )
    ).rows[0];

    if (!target || !environment) {
      throw new DomainError(
        'NOT_FOUND',
        'Target not found in this runbook’s project and environment.',
        404,
      );
    }

    if (target.agent_state !== 'active') {
      throw new DomainError('AGENT_UNAVAILABLE', 'The target’s agent must be active.', 409);
    }

    await this.control.store.get(p.organisation_id, version.manifest.artifact.digest);

    const resolved = await this.control.secrets.resolve(
      tx,
      p.organisation_id,
      version.project_id,
      version.environment_id,
      version.manifest.process.spec.secrets,
    );

    return {
      version,
      environment,
      target,
      requiresApproval:
        environment.requires_approval || version.manifest.process.spec.requiresApproval,
      bindings: resolved.map(({ variable, secret }) => ({
        variable,
        name: secret.name,
        version: secret.current_version,
      })),
    };
  }

  async review(tx: Transaction, p: Principal, input: z.infer<typeof runbookPlanInput>) {
    const checked = await this.preflight(tx, p, input.runbook_version_id, input.target_id);
    const { version, target, environment } = checked;

    const plan = (
      await tx.query<RunbookPlan>(
        `
          INSERT INTO
            runbook_plans (
              id,
              organisation_id,
              project_id,
              environment_id,
              runbook_version_id,
              target_id,
              expected_fence,
              policy_revision,
              requires_approval,
              secret_bindings,
              created_by
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING
            *
        `,
        [
          randomUUID(),
          p.organisation_id,
          version.project_id,
          version.environment_id,
          version.id,
          target.id,
          target.fence,
          environment.policy_revision,
          checked.requiresApproval,
          JSON.stringify(checked.bindings),
          p.actor_id,
        ],
      )
    ).rows[0];

    await this.control.audit(tx, p, 'runbook.reviewed', plan.id, {
      runbook_version_id: version.id,
      target_id: target.id,
      expected_fence: target.fence,
      project_id: version.project_id,
      environment_id: version.environment_id,
    });

    return {
      ...plan,
      version: version.version,
      manifest: version.manifest,
      target_name: target.name,
      agent_name: target.agent_name,
      environment_name: environment.name,
      warning:
        'This runs the reviewed command once. Cancellation and cleanup cannot undo database changes or other external effects. Check that it is safe to repeat after an interrupted run.',
    };
  }

  async request(tx: Transaction, p: Principal, id: string) {
    // Serialize reuse independently of the request idempotency key.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`runbook-plan:${id}`]);

    const plan = (
      await tx.query<RunbookPlan>(
        `
          SELECT
            p.*,
            p.expires_at <= clock_timestamp() AS expired,
            EXISTS (
              SELECT
                1
              FROM
                audit_events e
              WHERE
                e.organisation_id = p.organisation_id
                AND e.action = 'installation.restored'
                AND e.created_at > p.created_at
            ) AS restored
          FROM
            runbook_plans p
          WHERE
            p.organisation_id = $1
            AND p.id = $2
        `,
        [p.organisation_id, id],
      )
    ).rows[0];

    if (!plan) {
      throw new DomainError('NOT_FOUND', 'Runbook review not found.', 404);
    }

    assertScope(p, plan);

    if (plan.created_by !== p.actor_id) {
      throw new DomainError(
        'REVIEW_REQUIRED',
        'Create your own review before requesting this runbook.',
        403,
      );
    }

    if (plan.expired || plan.restored) {
      throw new DomainError(
        'STALE_RUNBOOK_REVIEW',
        'This review expired or predates installation recovery. Review the runbook again.',
        409,
      );
    }

    if (
      (
        await tx.query(
          'SELECT 1 FROM deployments WHERE organisation_id=$1 AND runbook_plan_id=$2',
          [p.organisation_id, id],
        )
      ).rowCount
    ) {
      throw new DomainError('RUNBOOK_ALREADY_REQUESTED', 'This review already has a run.', 409);
    }

    const checked = await this.preflight(tx, p, plan.runbook_version_id, plan.target_id);

    if (
      checked.target.fence !== plan.expected_fence ||
      checked.environment.policy_revision !== plan.policy_revision ||
      checked.requiresApproval !== plan.requires_approval ||
      !isDeepStrictEqual(checked.bindings, plan.secret_bindings)
    ) {
      throw new DomainError(
        'STALE_RUNBOOK_REVIEW',
        'The target, policy or secret versions changed. Review the runbook again.',
        409,
      );
    }

    const run = (
      await tx.query<RunbookRun>(
        `
          INSERT INTO
            deployments (
              id,
              organisation_id,
              project_id,
              environment_id,
              kind,
              status,
              requested_by,
              policy_snapshot,
              runbook_version_id,
              runbook_plan_id
            )
          VALUES
            ($1, $2, $3, $4, 'runbook', $5, $6, $7, $8, $9)
          RETURNING
            *
        `,
        [
          randomUUID(),
          p.organisation_id,
          plan.project_id,
          plan.environment_id,
          plan.requires_approval ? 'awaiting_approval' : 'queued',
          p.actor_id,
          { revision: plan.policy_revision, requires_approval: plan.requires_approval },
          plan.runbook_version_id,
          id,
        ],
      )
    ).rows[0];

    await this.control.secrets.bind(tx, run, checked.version.manifest.process.spec.secrets);

    await this.control.deploymentEvent(tx, p, run, {
      secret_bindings: plan.secret_bindings,
      acknowledge_external_effects: true,
    });

    return run;
  }
}
