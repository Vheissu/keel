import { Runbooks } from './runbooks.js';
import { auditEvent } from './audit.js';
import { authenticateToken, lockPrincipal } from './identity-policy.js';
import { enqueueNotifications } from './notifications.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  transaction,
  type Database,
  type Transaction,
} from '../../../packages/database/src/index.js';
import {
  DomainError,
  approveDeployment,
  type Principal,
  type Artifact,
  type Release,
  type Environment,
  type Deployment,
  type ExecutionRequest,
} from '../../../packages/domain/src/index.js';
import { parseProcess, requiresApproval } from '../../../packages/deployment-schema/src/index.js';
import { sha256, type ArtifactStore } from './artifact-store.js';
import { DeliveryPolicy } from './delivery-policy.js';
import { DeploymentSecrets } from './deployment-secrets.js';
import type { CredentialVault } from './credential-vault.js';

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const projectInput = z
  .object({ name, slug, description: z.string().trim().max(500).default('') })
  .strict();

export const artifactInput = z
  .object({ project_id: uuid, name, version, digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export const releaseInput = z
  .object({ project_id: uuid, artifact_id: uuid, version, process: z.unknown() })
  .strict();

export const deploymentInput = z.object({ release_id: uuid, environment_id: uuid }).strict();

export class ControlPlane {
  readonly runbooks = new Runbooks(this);
  readonly delivery = new DeliveryPolicy(this);
  readonly secrets: DeploymentSecrets;

  constructor(
    public db: Database,
    public store: ArtifactStore,
    secretVault?: CredentialVault,
  ) {
    this.secrets = new DeploymentSecrets(this, secretVault);
  }

  async authenticate(token: string): Promise<Principal> {
    return authenticateToken(this.db, sha256(token));
  }

  async mutate<T>(
    principal: Principal,
    key: string,
    fingerprint: string,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Supply an Idempotency-Key of 8–128 letters, numbers, dots, colons, underscores or hyphens.',
      );
    }

    if (principal.project_ids) {
      fingerprint = sha256(JSON.stringify([fingerprint, [...principal.project_ids].sort()]));
    }

    if (principal.environment_ids) {
      fingerprint = sha256(
        JSON.stringify([fingerprint, { environment_ids: [...principal.environment_ids].sort() }]),
      );
    }

    return transaction(this.db, async (tx) => {
      await lockPrincipal(tx, principal);

      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${principal.organisation_id}:${principal.actor_id}:${key}`,
      ]);

      const previous = await tx.query(
        `
          SELECT
            *
          FROM
            idempotency_keys
          WHERE
            organisation_id = $1
            AND actor_id = $2
            AND key = $3
        `,
        [principal.organisation_id, principal.actor_id, key],
      );

      if (previous.rowCount) {
        if (previous.rows[0].request_hash !== fingerprint) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key was already used for a different request.',
            409,
          );
        }

        return previous.rows[0].response as T;
      }

      const result = await work(tx);

      await tx.query(
        `
          INSERT INTO
            idempotency_keys (
              organisation_id,
              actor_id,
              key,
              request_hash,
              response
            )
          VALUES
            ($1, $2, $3, $4, $5)
        `,
        [principal.organisation_id, principal.actor_id, key, fingerprint, JSON.stringify(result)],
      );

      return result;
    });
  }

  async audit(
    tx: Transaction,
    p: Principal,
    action: string,
    resource: string,
    details: object = {},
  ) {
    return auditEvent(tx, p, action, resource, details);
  }

  async project(tx: Transaction, p: Principal, input: z.infer<typeof projectInput>) {
    const result = await tx.query(
      `
        INSERT INTO
          projects (id, organisation_id, name, slug, description)
        VALUES
          ($1, $2, $3, $4, $5)
        RETURNING
          *
      `,
      [randomUUID(), p.organisation_id, input.name, input.slug, input.description],
    );

    await this.audit(tx, p, 'project.created', result.rows[0].id, { name: input.name });

    return result.rows[0];
  }

  async artifact(
    tx: Transaction,
    p: Principal,
    input: z.infer<typeof artifactInput>,
    bytes: Buffer,
    provenance: Record<string, unknown> = { source: 'direct-upload', published_by: p.actor_id },
  ) {
    if (
      !(
        await tx.query('SELECT 1 FROM projects WHERE organisation_id=$1 AND id=$2', [
          p.organisation_id,
          input.project_id,
        ])
      ).rowCount
    ) {
      throw new DomainError('NOT_FOUND', 'Project not found.', 404);
    }

    if (!bytes.length) {
      throw new DomainError('EMPTY_ARTIFACT', 'An artifact must contain at least one byte.');
    }

    await this.store.put(p.organisation_id, input.digest, bytes);

    const result = await tx.query(
      `
        INSERT INTO
          artifacts (
            id,
            organisation_id,
            project_id,
            name,
            version,
            digest,
            size,
            provenance
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
        input.name,
        input.version,
        input.digest,
        bytes.length,
        provenance,
      ],
    );

    await this.audit(tx, p, 'artifact.published', result.rows[0].id, {
      name: input.name,
      version: input.version,
      digest: input.digest,
    });

    return result.rows[0];
  }

  async release(tx: Transaction, p: Principal, input: z.infer<typeof releaseInput>) {
    const artifact = (
      await tx.query<Artifact>(
        `
          SELECT
            *
          FROM
            artifacts
          WHERE
            organisation_id = $1
            AND project_id = $2
            AND id = $3
        `,
        [p.organisation_id, input.project_id, input.artifact_id],
      )
    ).rows[0];

    if (!artifact) {
      throw new DomainError('NOT_FOUND', 'Artifact not found in this project.', 404);
    }

    const process = parseProcess(input.process);

    if (process.spec.artifact.name !== artifact.name) {
      throw new DomainError(
        'ARTIFACT_NAME_MISMATCH',
        'The process artifact name must match the retained artifact.',
      );
    }

    await this.store.get(p.organisation_id, artifact.digest);

    const manifest = {
      schema_version: 1,
      artifact: {
        id: artifact.id,
        name: artifact.name,
        digest: artifact.digest,
        size: artifact.size,
      },
      process,
      provenance: artifact.provenance,
    };

    const result = await tx.query(
      `
        INSERT INTO
          releases (
            id,
            organisation_id,
            project_id,
            version,
            artifact_id,
            manifest
          )
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING
          *
      `,
      [randomUUID(), p.organisation_id, input.project_id, input.version, artifact.id, manifest],
    );

    await this.audit(tx, p, 'release.created', result.rows[0].id, {
      version: input.version,
      digest: artifact.digest,
    });

    return result.rows[0];
  }

  async deploymentEvent(
    tx: Transaction,
    p: Principal,
    deployment: ExecutionRequest,
    context: Record<string, unknown> = {},
  ) {
    const eventId = randomUUID();

    await tx.query(
      `
        INSERT INTO
          deployment_events (
            id,
            organisation_id,
            deployment_id,
            status,
            actor_id
          )
        VALUES
          ($1, $2, $3, $4, $5)
      `,
      [eventId, p.organisation_id, deployment.id, deployment.status, p.actor_id],
    );

    if (deployment.kind !== 'runbook') {
      await enqueueNotifications(tx, deployment, eventId);
    }

    const eventType = deployment.kind === 'runbook' ? 'runbook' : 'deployment';

    // The dispatcher starts each queued deployment with a stable Temporal workflow ID.
    await tx.query('INSERT INTO outbox(id,organisation_id,topic,payload) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      p.organisation_id,
      `${eventType}.${deployment.status}`,
      { deployment_id: deployment.id },
    ]);

    await this.audit(tx, p, `${eventType}.${deployment.status}`, deployment.id, {
      release_id: deployment.release_id,
      ...(deployment.kind === 'runbook'
        ? {
            runbook_version_id: deployment.runbook_version_id,
            runbook_plan_id: deployment.runbook_plan_id,
          }
        : {}),
      environment_id: deployment.environment_id,
      kind: deployment.kind,
      promotion_source_deployment_id: deployment.promotion_source_deployment_id,
      policy_snapshot: deployment.policy_snapshot,
      rollback_plan_id: deployment.rollback_plan_id,
      ...context,
    });
  }

  async deploy(
    tx: Transaction,
    p: Principal,
    input: z.infer<typeof deploymentInput>,
    rollbackPlanId: string | null = null,
  ) {
    const release = (
      await tx.query<Release>('SELECT * FROM releases WHERE organisation_id=$1 AND id=$2', [
        p.organisation_id,
        input.release_id,
      ])
    ).rows[0];

    const environment = (
      await tx.query<Environment>(
        'SELECT * FROM environments WHERE organisation_id=$1 AND id=$2 FOR SHARE',
        [p.organisation_id, input.environment_id],
      )
    ).rows[0];

    if (!release || !environment) {
      throw new DomainError('NOT_FOUND', 'Release or environment not found.', 404);
    }

    const process = parseProcess(release.manifest.process);
    const config = process.spec.environments[environment.slug];

    if (!config) {
      throw new DomainError(
        'ENVIRONMENT_NOT_CONFIGURED',
        'This release has no process for the selected environment.',
      );
    }

    await this.store.get(p.organisation_id, release.manifest.artifact.digest);

    const evidence = await this.delivery.evidence(tx, p.organisation_id, release, environment);

    const policy = {
      revision: environment.policy_revision,
      promotion_from_environment_id: environment.promotion_from_environment_id,
      requires_approval: requiresApproval(environment, config),
    };

    const status = policy.requires_approval ? 'awaiting_approval' : 'queued';

    const result = await tx.query<Deployment>(
      `
        INSERT INTO
          deployments (
            id,
            organisation_id,
            project_id,
            release_id,
            environment_id,
            status,
            requested_by,
            kind,
            promotion_source_deployment_id,
            policy_snapshot,
            rollback_plan_id
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING
          *
      `,
      [
        randomUUID(),
        p.organisation_id,
        release.project_id,
        release.id,
        environment.id,
        status,
        p.actor_id,
        rollbackPlanId ? 'rollback' : 'deploy',
        evidence,
        policy,
        rollbackPlanId,
      ],
    );

    const secretBindings = await this.secrets.bind(tx, result.rows[0], config.secrets);

    if (secretBindings.length) {
      await this.audit(tx, p, 'deployment.secrets_bound', result.rows[0].id, {
        bindings: secretBindings,
      });
    }

    await this.deploymentEvent(tx, p, result.rows[0]);

    return result.rows[0];
  }

  async transition(
    tx: Transaction,
    p: Principal,
    id: string,
    action: 'approve' | 'reject' | 'cancel',
    runbook = false,
  ) {
    const d = (
      await tx.query<ExecutionRequest>(
        "SELECT * FROM deployments WHERE organisation_id=$1 AND id=$2 AND (kind='runbook')=$3 FOR UPDATE",
        [p.organisation_id, uuid.parse(id), runbook],
      )
    ).rows[0];

    if (!d) {
      throw new DomainError(
        'NOT_FOUND',
        runbook ? 'Runbook run not found.' : 'Deployment not found.',
        404,
      );
    }

    if (action === 'approve' || action === 'reject') {
      approveDeployment(d, p);
    } else if (
      !['queued', 'awaiting_approval', 'running', 'reconciliation_required'].includes(d.status)
    ) {
      throw new DomainError('INVALID_STATE', 'This request can no longer be cancelled.', 409);
    }

    if (action === 'approve' && d.kind === 'runbook') {
      const version = await this.runbooks.version(tx, p.organisation_id, d.runbook_version_id);

      await this.store.get(p.organisation_id, version.manifest.artifact.digest);
    } else if (action === 'approve') {
      const release = (
        await tx.query<Release>('SELECT * FROM releases WHERE organisation_id=$1 AND id=$2', [
          p.organisation_id,
          d.release_id,
        ])
      ).rows[0];

      await this.store.get(p.organisation_id, release.manifest.artifact.digest);
    }

    const transitionStatuses = {
      approve: 'queued',
      reject: 'rejected',
      cancel: 'cancelled',
    } as const;

    const status =
      action === 'cancel' && ['running', 'reconciliation_required'].includes(d.status)
        ? 'cancel_requested'
        : transitionStatuses[action];

    const result = await tx.query<ExecutionRequest>(
      `
        UPDATE deployments
        SET
          status = $1,
          approved_by = $2,
          updated_at = now()
        WHERE
          organisation_id = $3
          AND id = $4
        RETURNING
          *
      `,
      [status, action === 'approve' ? p.actor_id : d.approved_by, p.organisation_id, id],
    );

    await this.deploymentEvent(
      tx,
      p,
      result.rows[0],
      runbook && action === 'approve' ? { acknowledge_external_effects: true } : {},
    );

    return result.rows[0];
  }
}
