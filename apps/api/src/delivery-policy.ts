import { z } from 'zod';
import {
  readOnlySnapshot,
  transaction,
  type Transaction,
} from '../../../packages/database/src/index.js';
import {
  DomainError,
  type Environment,
  type Principal,
  type Release,
} from '../../../packages/domain/src/index.js';
import { parseProcess, requiresApproval } from '../../../packages/deployment-schema/src/index.js';
import type { ControlPlane } from './control-plane.js';

export const policyInput = z
  .object({
    promotion_from_environment_id: z.string().uuid().nullable(),
    expected_revision: z.number().int().positive(),
  })
  .strict();

export class DeliveryPolicy {
  constructor(private control: ControlPlane) {}

  async update(tx: Transaction, p: Principal, id: string, input: z.infer<typeof policyInput>) {
    // Serialize policy edits across the organisation so concurrent edits cannot create a cycle.
    await tx.query('SELECT id FROM organisations WHERE id=$1 FOR UPDATE', [p.organisation_id]);

    const environments = (
      await tx.query<Environment>('SELECT * FROM environments WHERE organisation_id=$1', [
        p.organisation_id,
      ])
    ).rows;

    const environment = environments.find((item) => item.id === id);

    if (
      !environment ||
      (input.promotion_from_environment_id &&
        !environments.some((item) => item.id === input.promotion_from_environment_id))
    ) {
      throw new DomainError('NOT_FOUND', 'Environment not found in this workspace.', 404);
    }

    if (environment.policy_revision !== input.expected_revision) {
      throw new DomainError(
        'POLICY_CHANGED',
        'The environment policy changed. Refresh before saving.',
        409,
      );
    }

    const sources = new Map(
      environments.map((item) => [item.id, item.promotion_from_environment_id]),
    );

    sources.set(id, input.promotion_from_environment_id);
    const seen = new Set<string>();
    let current: string | null = id;

    while (current) {
      if (seen.has(current)) {
        throw new DomainError('POLICY_CYCLE', 'Promotion prerequisites cannot form a cycle.');
      }

      seen.add(current);
      current = sources.get(current) ?? null;
    }

    const result = await tx.query<Environment>(
      `
        UPDATE environments
        SET
          promotion_from_environment_id = $3,
          policy_revision = policy_revision + 1
        WHERE
          organisation_id = $1
          AND id = $2
        RETURNING
          *
      `,
      [p.organisation_id, id, input.promotion_from_environment_id],
    );

    await this.control.audit(tx, p, 'environment.promotion_policy_changed', id, {
      previous_source: environment.promotion_from_environment_id,
      promotion_from_environment_id: input.promotion_from_environment_id,
      revision: result.rows[0].policy_revision,
    });

    return result.rows[0];
  }

  async evidence(tx: Transaction, org: string, release: Release, environment: Environment) {
    if (!environment.promotion_from_environment_id) {
      return null;
    }

    const result = await tx.query<{ id: string }>(
      `
        SELECT
          d.id
        FROM
          deployments d
          JOIN deployment_attempts a ON a.organisation_id = d.organisation_id
          AND a.deployment_id = d.id
        WHERE
          d.organisation_id = $1
          AND d.project_id = $2
          AND d.release_id = $3
          AND d.environment_id = $4
          AND d.status = 'succeeded'
          AND d.result_code = 'HTTP_VERIFIED'
          AND a.state = 'succeeded'
          AND a.result_code = 'HTTP_VERIFIED'
          AND a.fence > 0
        ORDER BY
          d.updated_at DESC,
          d.id
        LIMIT
          1
      `,
      [org, release.project_id, release.id, environment.promotion_from_environment_id],
    );

    if (!result.rowCount) {
      throw new DomainError(
        'PROMOTION_REQUIRED',
        'This exact release needs a verified deployment in the prerequisite environment first.',
        409,
      );
    }

    return result.rows[0].id;
  }

  async inspect(org: string, releaseId: string, environmentId: string) {
    return transaction(
      this.control.db,
      async (tx) => {
        const release = (
          await tx.query<Release>('SELECT * FROM releases WHERE organisation_id=$1 AND id=$2', [
            org,
            releaseId,
          ])
        ).rows[0];

        const environment = (
          await tx.query<Environment>(
            'SELECT * FROM environments WHERE organisation_id=$1 AND id=$2',
            [org, environmentId],
          )
        ).rows[0];

        if (!release || !environment) {
          throw new DomainError('NOT_FOUND', 'Release or environment not found.', 404);
        }

        const config = parseProcess(release.manifest.process).spec.environments[environment.slug];

        if (!config) {
          throw new DomainError(
            'ENVIRONMENT_NOT_CONFIGURED',
            'This release has no process for the selected environment.',
          );
        }

        let evidence: string | null = null;
        let reason: string | null = null;

        try {
          evidence = await this.evidence(tx, org, release, environment);
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'PROMOTION_REQUIRED') {
            throw error;
          }

          reason = error.message;
        }

        return {
          eligible: !reason,
          reason,
          policy_revision: environment.policy_revision,
          promotion_from_environment_id: environment.promotion_from_environment_id,
          source_deployment_id: evidence,
          requires_approval: requiresApproval(environment, config),
          digest: release.manifest.artifact.digest,
        };
      },
      readOnlySnapshot,
    );
  }
}
