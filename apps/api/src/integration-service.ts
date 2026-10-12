import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from '../../../packages/database/src/index.js';
import { DomainError, type Principal } from '../../../packages/domain/src/index.js';
import type { ProviderConnection } from '../../../packages/integrations/src/index.js';
import {
  GitHubActionsAdapter,
  githubRepository,
  externalId,
  type GitHubCredentials,
} from '../../../packages/integrations/src/github-actions.js';
import {
  BitbucketPipelinesAdapter,
  type BitbucketCredentials,
} from '../../../packages/integrations/src/bitbucket-pipelines.js';
import { bitbucketConnectionInput, bitbucketCredentialsInput } from './bitbucket-input.js';
import { CredentialVault } from './credential-vault.js';
import { ControlPlane } from './control-plane.js';

export const credentialsInput = z
  .object({
    token: z.string().trim().min(16).max(1024),
    webhook_secret: z.string().min(32).max(256),
  })
  .strict();

export const connectionInput = credentialsInput
  .extend({
    name: z.string().trim().min(1).max(100),
    project_id: z.string().uuid(),
    repository: githubRepository,
    workflow_id: externalId,
    branch: z.string().trim().min(1).max(255),
    artifact_name: z.string().trim().min(1).max(100),
  })
  .strict();

export const importInput = z
  .object({
    run_id: externalId,
    run_attempt: z.number().int().positive().max(10000).default(1),
  })
  .strict();

export interface ProviderConnectionRecord {
  id: string;
  organisation_id: string;
  project_id: string;
  created_by: string;
  provider: 'github-actions' | 'bitbucket-pipelines';
  name: string;
  repository: string;
  repository_id: string;
  workflow_id: string;
  branch: string;
  artifact_name: string;
  enabled: boolean;
  credential_revision: number;
  credentials: unknown;
  created_at: string;
}

export interface ImportJob {
  id: string;
  organisation_id: string;
  project_id: string;
  connection_id: string;
  requested_by: string;
  run_id: string;
  run_attempt: number;
  attempts: number;
  lease_token: string;
  created_at: string;
  candidate_digest: string | null;
  candidate_commit: string | null;
  candidate_step_id: string | null;
}

export const connectionColumns = `id, organisation_id, project_id, created_by, provider, name,
  repository, repository_id, workflow_id, branch, artifact_name, enabled, credential_revision, created_at`;

export const importColumns = `id, project_id, connection_id, run_id, run_attempt, status, attempts,
  available_at, artifact_id, error_code, error_message, created_at, updated_at`;

export function adapterConnection(connection: ProviderConnectionRecord): ProviderConnection {
  return {
    id: connection.id,
    organisationId: connection.organisation_id,
    provider: connection.provider,
    repository: connection.repository,
  };
}

export class IntegrationService {
  constructor(
    public control: ControlPlane,
    private vault?: CredentialVault,
    private createAdapter = (credentials: GitHubCredentials) =>
      new GitHubActionsAdapter(async () => credentials),
    private createBitbucketAdapter = (credentials: BitbucketCredentials) =>
      new BitbucketPipelinesAdapter(credentials),
  ) {}

  get configured() {
    return this.vault !== undefined;
  }

  private requireVault() {
    if (!this.vault) {
      throw new DomainError(
        'CREDENTIAL_KEY_REQUIRED',
        'Configure KEEL_CREDENTIAL_KEY before connecting a provider.',
        503,
      );
    }

    return this.vault;
  }

  credentials(connection: ProviderConnectionRecord) {
    return this.requireVault().decrypt<z.infer<typeof credentialsInput>>(
      connection.organisation_id,
      connection.id,
      connection.credentials,
    );
  }

  adapter(connection: ProviderConnectionRecord) {
    if (connection.provider !== 'github-actions') {
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        'Bitbucket uses a publishing step; workflow and artifact discovery are unavailable.',
        422,
      );
    }

    return this.createAdapter({
      token: this.credentials(connection).token,
      repository: connection.repository,
    });
  }

  bitbucketCredentials(connection: ProviderConnectionRecord) {
    return this.requireVault().decrypt<z.infer<typeof bitbucketCredentialsInput>>(
      connection.organisation_id,
      connection.id,
      connection.credentials,
    );
  }

  bitbucketAdapter(connection: ProviderConnectionRecord) {
    return this.createBitbucketAdapter({
      token: this.bitbucketCredentials(connection).token,
      repository: connection.repository,
    });
  }

  async createBitbucket(
    tx: Transaction,
    principal: Principal,
    input: z.infer<typeof bitbucketConnectionInput>,
  ) {
    const vault = this.requireVault();

    const project = await tx.query(
      'SELECT 1 FROM projects WHERE organisation_id = $1 AND id = $2',
      [principal.organisation_id, input.project_id],
    );

    if (!project.rowCount) {
      throw new DomainError('NOT_FOUND', 'Project not found.', 404);
    }

    const repository = await this.createBitbucketAdapter(input).verifyConnection();
    const id = randomUUID();

    const credentials = vault.encrypt(principal.organisation_id, id, {
      token: input.token,
      publish_secret: input.publish_secret,
    });

    const result = await tx.query(
      `
        INSERT INTO
          provider_connections (
            id,
            organisation_id,
            project_id,
            created_by,
            provider,
            name,
            repository,
            repository_id,
            workflow_id,
            branch,
            artifact_name,
            credentials
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4,
            'bitbucket-pipelines',
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11
          )
        RETURNING
          ${connectionColumns}
      `,
      [
        id,
        principal.organisation_id,
        input.project_id,
        principal.actor_id,
        input.name,
        repository.full_name,
        repository.uuid,
        input.workflow_id,
        input.branch,
        input.artifact_name,
        credentials,
      ],
    );

    await this.control.audit(tx, principal, 'integration.connected', id, {
      provider: 'bitbucket-pipelines',
      repository: repository.full_name,
    });

    return result.rows[0];
  }

  async rotateBitbucket(
    tx: Transaction,
    principal: Principal,
    id: string,
    input: z.infer<typeof bitbucketCredentialsInput>,
  ) {
    const connection = await this.load(principal.organisation_id, id, tx);

    if (connection.provider !== 'bitbucket-pipelines') {
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        'This connection is not a Bitbucket connection.',
        422,
      );
    }

    const repository = await this.createBitbucketAdapter({
      token: input.token,
      repository: connection.repository,
    }).verifyConnection();

    if (repository.uuid !== connection.repository_id) {
      throw new DomainError(
        'REPOSITORY_CHANGED',
        'This name now identifies a different repository. Create a new connection.',
        409,
      );
    }

    const credentials = this.requireVault().encrypt(principal.organisation_id, id, input);

    const result = await tx.query(
      `
        UPDATE provider_connections
        SET
          credentials = $3,
          credential_revision = credential_revision + 1
        WHERE
          organisation_id = $1
          AND id = $2
        RETURNING
          ${connectionColumns}
      `,
      [principal.organisation_id, id, credentials],
    );

    await this.control.audit(tx, principal, 'integration.credentials_rotated', id);

    return result.rows[0];
  }

  async load(organisation: string, id: string, db: Database | Transaction = this.control.db) {
    const result = await db.query<ProviderConnectionRecord>(
      'SELECT * FROM provider_connections WHERE organisation_id = $1 AND id = $2',
      [organisation, z.string().uuid().parse(id)],
    );

    if (!result.rows[0]) {
      throw new DomainError('NOT_FOUND', 'Provider connection not found.', 404);
    }

    return result.rows[0];
  }

  async create(tx: Transaction, principal: Principal, input: z.infer<typeof connectionInput>) {
    const vault = this.requireVault();

    const project = await tx.query(
      'SELECT 1 FROM projects WHERE organisation_id = $1 AND id = $2',
      [principal.organisation_id, input.project_id],
    );

    if (!project.rowCount) {
      throw new DomainError('NOT_FOUND', 'Project not found.', 404);
    }

    const id = randomUUID();

    const connection = {
      id,
      organisationId: principal.organisation_id,
      provider: 'github-actions' as const,
      repository: input.repository,
    };

    const repository = await this.createAdapter(input).verifyConnection(
      connection,
      input.workflow_id,
    );

    const credentials = vault.encrypt(principal.organisation_id, id, {
      token: input.token,
      webhook_secret: input.webhook_secret,
    });

    const result = await tx.query(
      `
        INSERT INTO
          provider_connections (
            id,
            organisation_id,
            project_id,
            created_by,
            provider,
            name,
            repository,
            repository_id,
            workflow_id,
            branch,
            artifact_name,
            credentials
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4,
            'github-actions',
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11
          )
        RETURNING
          ${connectionColumns}
      `,
      [
        id,
        principal.organisation_id,
        input.project_id,
        principal.actor_id,
        input.name,
        repository.full_name,
        repository.id,
        input.workflow_id,
        input.branch,
        input.artifact_name,
        credentials,
      ],
    );

    await this.control.audit(tx, principal, 'integration.connected', id, {
      provider: 'github-actions',
      repository: repository.full_name,
    });

    return result.rows[0];
  }

  async rotate(
    tx: Transaction,
    principal: Principal,
    id: string,
    input: z.infer<typeof credentialsInput>,
  ) {
    const connection = await this.load(principal.organisation_id, id, tx);

    if (connection.provider !== 'github-actions') {
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        'Use the Bitbucket credentials endpoint.',
        422,
      );
    }

    const repository = await this.createAdapter({
      token: input.token,
      repository: connection.repository,
    }).verifyConnection(adapterConnection(connection), connection.workflow_id);

    if (repository.id !== connection.repository_id) {
      throw new DomainError(
        'REPOSITORY_CHANGED',
        'This name now identifies a different repository. Create a new connection.',
        409,
      );
    }

    const credentials = this.requireVault().encrypt(principal.organisation_id, id, input);

    const result = await tx.query(
      `
        UPDATE provider_connections
        SET
          credentials = $3,
          credential_revision = credential_revision + 1
        WHERE
          organisation_id = $1
          AND id = $2
        RETURNING
          ${connectionColumns}
      `,
      [principal.organisation_id, id, credentials],
    );

    await this.control.audit(tx, principal, 'integration.credentials_rotated', id);

    return result.rows[0];
  }

  async setEnabled(tx: Transaction, principal: Principal, id: string, enabled: boolean) {
    await this.load(principal.organisation_id, id, tx);

    const result = await tx.query(
      `
        UPDATE provider_connections
        SET
          enabled = $3,
          credential_revision = credential_revision + 1
        WHERE
          organisation_id = $1
          AND id = $2
        RETURNING
          ${connectionColumns}
      `,
      [principal.organisation_id, id, enabled],
    );

    await this.control.audit(
      tx,
      principal,
      enabled ? 'integration.enabled' : 'integration.disabled',
      id,
    );

    return result.rows[0];
  }

  async enqueue(
    tx: Transaction,
    principal: Principal,
    id: string,
    input: z.infer<typeof importInput>,
  ) {
    this.requireVault();
    const connection = await this.load(principal.organisation_id, id, tx);

    if (connection.provider !== 'github-actions') {
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        'Upload this artifact using the Bitbucket publishing step.',
        422,
      );
    }

    if (!connection.enabled) {
      throw new DomainError(
        'CONNECTION_DISABLED',
        'Enable the connection before importing artifacts.',
        409,
      );
    }

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
            run_attempt
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (connection_id, run_id, run_attempt) DO NOTHING
        RETURNING
          ${importColumns}
      `,
      [
        randomUUID(),
        principal.organisation_id,
        connection.project_id,
        connection.id,
        principal.actor_id,
        input.run_id,
        input.run_attempt,
      ],
    );

    if (result.rows[0]) {
      await this.control.audit(tx, principal, 'artifact.import_requested', result.rows[0].id, {
        connection_id: id,
        run_id: input.run_id,
        run_attempt: input.run_attempt,
      });

      return result.rows[0];
    }

    return (
      await tx.query(
        `
          SELECT
            ${importColumns}
          FROM
            artifact_imports
          WHERE
            organisation_id = $1
            AND connection_id = $2
            AND run_id = $3
            AND run_attempt = $4
        `,
        [principal.organisation_id, id, input.run_id, input.run_attempt],
      )
    ).rows[0];
  }

  async retry(tx: Transaction, principal: Principal, id: string) {
    const result = await tx.query(
      `
        UPDATE artifact_imports
        SET
          status = 'pending',
          attempts = 0,
          available_at = now(),
          error_code = NULL,
          error_message = NULL,
          updated_at = now()
        WHERE
          organisation_id = $1
          AND id = $2
          AND status = 'failed'
        RETURNING
          ${importColumns}
      `,
      [principal.organisation_id, z.string().uuid().parse(id)],
    );

    if (!result.rows[0]) {
      throw new DomainError(
        'IMPORT_NOT_RETRYABLE',
        'Only a failed import in this workspace can be retried.',
        409,
      );
    }

    await this.control.audit(tx, principal, 'artifact.import_retried', id);

    return result.rows[0];
  }
}
