import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '../../../packages/database/src/index.js';
import {
  DomainError,
  type ExecutionRequest,
  type Principal,
} from '../../../packages/domain/src/index.js';
import {
  maxSecretValueBytes,
  secretName,
  type DeploymentProcess,
} from '../../../packages/deployment-schema/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { CredentialVault } from './credential-vault.js';

export const secretValue = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, 'utf8') <= maxSecretValueBytes &&
      !/[\x00\r\n]/.test(value) &&
      Buffer.from(value, 'utf8').toString('utf8') === value,
    `Use a single-line value of at most ${maxSecretValueBytes} UTF-8 bytes, without NUL characters.`,
  );

export const secretCreateInput = z
  .object({
    project_id: z.string().uuid(),
    environment_id: z.string().uuid(),
    name: secretName,
    value: secretValue,
  })
  .strict();

export const secretRotateInput = z
  .object({
    value: secretValue,
    expected_revision: z.number().int().positive(),
  })
  .strict();

export const secretRevokeInput = secretRotateInput.omit({ value: true });

interface Secret {
  id: string;
  organisation_id: string;
  project_id: string;
  environment_id: string;
  name: string;
  revision: number;
  current_version: number;
  disabled: boolean;
}

type References = DeploymentProcess['spec']['environments'][string]['secrets'];

// Binds each ciphertext to its scope, name and version. Recovery verification uses it too.
export function secretContext(
  secret: Pick<Secret, 'project_id' | 'environment_id' | 'id' | 'name'>,
  version: number,
) {
  return `${secret.project_id}:${secret.environment_id}:${secret.id}:${secret.name}:${version}`;
}

export class DeploymentSecrets {
  constructor(
    private control: ControlPlane,
    private encryption?: CredentialVault,
  ) {}

  private vault() {
    if (!this.encryption) {
      throw new DomainError(
        'SECRETS_UNAVAILABLE',
        'Deployment secret encryption is not configured.',
        503,
      );
    }

    return this.encryption;
  }

  fingerprint(value: string) {
    return this.vault().fingerprint(value);
  }

  async scope(tx: Transaction, org: string, project: string, environment: string) {
    const found = await tx.query(
      `
        SELECT
          1
        FROM
          projects p
          JOIN environments e ON e.organisation_id = p.organisation_id
        WHERE
          p.organisation_id = $1
          AND p.id = $2
          AND e.id = $3
      `,
      [org, project, environment],
    );

    if (!found.rowCount) {
      throw new DomainError('NOT_FOUND', 'Project or environment not found.', 404);
    }
  }

  async list(org: string, project: string, environment: string) {
    const tx = await this.control.db.connect();

    try {
      await this.scope(tx, org, project, environment);

      return (
        await tx.query(
          `
            SELECT
              *
            FROM
              deployment_secrets
            WHERE
              organisation_id = $1
              AND project_id = $2
              AND environment_id = $3
            ORDER BY
              name
          `,
          [org, project, environment],
        )
      ).rows;
    } finally {
      tx.release();
    }
  }

  private async lock(tx: Transaction, org: string, id: string, revision: number) {
    const secret = (
      await tx.query<Secret>(
        'SELECT * FROM deployment_secrets WHERE organisation_id=$1 AND id=$2 FOR UPDATE',
        [org, id],
      )
    ).rows[0];

    if (!secret) {
      throw new DomainError('NOT_FOUND', 'Secret not found.', 404);
    }

    if (secret.revision !== revision) {
      throw new DomainError('SECRET_CHANGED', 'This secret changed. Refresh before saving.', 409);
    }

    return secret;
  }

  private async version(tx: Transaction, p: Principal, secret: Secret, value: string) {
    const encrypted = this.vault().encrypt(
      p.organisation_id,
      secretContext(secret, secret.current_version),
      value,
    );

    await tx.query(
      `
        INSERT INTO
          deployment_secret_versions (
            organisation_id,
            project_id,
            environment_id,
            secret_id,
            version,
            encrypted_value,
            created_by
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        p.organisation_id,
        secret.project_id,
        secret.environment_id,
        secret.id,
        secret.current_version,
        encrypted,
        p.actor_id,
      ],
    );
  }

  async create(tx: Transaction, p: Principal, input: z.infer<typeof secretCreateInput>) {
    await this.scope(tx, p.organisation_id, input.project_id, input.environment_id);

    const secret = (
      await tx.query<Secret>(
        `
          INSERT INTO
            deployment_secrets (
              id,
              organisation_id,
              project_id,
              environment_id,
              name
            )
          VALUES
            ($1, $2, $3, $4, $5)
          RETURNING
            *
        `,
        [randomUUID(), p.organisation_id, input.project_id, input.environment_id, input.name],
      )
    ).rows[0];

    await this.version(tx, p, secret, input.value);
    await this.record(tx, p, 'secret.created', secret);

    return secret;
  }

  async rotate(
    tx: Transaction,
    p: Principal,
    id: string,
    input: z.infer<typeof secretRotateInput>,
  ) {
    await this.lock(tx, p.organisation_id, id, input.expected_revision);

    const secret = (
      await tx.query<Secret>(
        `
          UPDATE deployment_secrets
          SET
            current_version = current_version + 1,
            revision = revision + 1,
            disabled = FALSE,
            updated_at = now()
          WHERE
            organisation_id = $1
            AND id = $2
          RETURNING
            *
        `,
        [p.organisation_id, id],
      )
    ).rows[0];

    await this.version(tx, p, secret, input.value);
    await this.record(tx, p, 'secret.rotated', secret);

    return secret;
  }

  async revoke(tx: Transaction, p: Principal, id: string, revision: number) {
    await this.lock(tx, p.organisation_id, id, revision);

    await tx.query(
      `
        UPDATE deployment_secret_versions
        SET
          revoked_at = now()
        WHERE
          organisation_id = $1
          AND secret_id = $2
          AND revoked_at IS NULL
      `,
      [p.organisation_id, id],
    );

    const secret = (
      await tx.query<Secret>(
        `
          UPDATE deployment_secrets
          SET
            disabled = TRUE,
            revision = revision + 1,
            updated_at = now()
          WHERE
            organisation_id = $1
            AND id = $2
          RETURNING
            *
        `,
        [p.organisation_id, id],
      )
    ).rows[0];

    await this.record(tx, p, 'secret.revoked', secret);

    return secret;
  }

  private async record(tx: Transaction, p: Principal, action: string, secret: Secret) {
    await this.control.audit(tx, p, action, secret.id, {
      project_id: secret.project_id,
      environment_id: secret.environment_id,
      name: secret.name,
      version: secret.current_version,
      revision: secret.revision,
    });
  }

  async resolve(
    tx: Transaction,
    org: string,
    project: string,
    environment: string,
    references: References,
  ) {
    const entries = Object.entries(references ?? {}).sort(([a], [b]) => a.localeCompare(b));

    if (!entries.length) {
      return [];
    }

    // Lock in secret-ID order, including aliases referring to the same secret once.
    const rows = (
      await tx.query<Secret>(
        `
          SELECT
            *
          FROM
            deployment_secrets
          WHERE
            organisation_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND name = ANY ($4::TEXT[])
          ORDER BY
            id
          FOR SHARE
        `,
        [org, project, environment, entries.map(([, reference]) => reference.secret)],
      )
    ).rows;

    return entries.map(([variable, reference]) => {
      const secret = rows.find((item) => item.name === reference.secret);

      if (!secret || secret.disabled) {
        throw new DomainError(
          'SECRET_UNAVAILABLE',
          `Secret ${reference.secret} is missing or revoked in this project and environment.`,
          409,
        );
      }

      return { variable, secret };
    });
  }

  async inspect(
    tx: Transaction,
    org: string,
    project: string,
    environment: string,
    references: References,
  ) {
    const entries = Object.entries(references ?? {});

    if (!entries.length) {
      return [];
    }

    const rows = (
      await tx.query<Secret>(
        `
          SELECT
            *
          FROM
            deployment_secrets
          WHERE
            organisation_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND name = ANY ($4::TEXT[])
        `,
        [org, project, environment, entries.map(([, reference]) => reference.secret)],
      )
    ).rows;

    return entries.map(([variable, reference]) => {
      const secret = rows.find((item) => item.name === reference.secret);

      return {
        variable,
        name: reference.secret,
        version: secret?.current_version ?? null,
        available: !!secret && !secret.disabled,
      };
    });
  }

  async bind(tx: Transaction, deployment: ExecutionRequest, references: References) {
    const bindings = await this.resolve(
      tx,
      deployment.organisation_id,
      deployment.project_id,
      deployment.environment_id,
      references,
    );

    for (const { variable, secret } of bindings) {
      await tx.query(
        `
          INSERT INTO
            deployment_secret_bindings (
              organisation_id,
              project_id,
              environment_id,
              deployment_id,
              variable,
              secret_id,
              version
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          deployment.organisation_id,
          deployment.project_id,
          deployment.environment_id,
          deployment.id,
          variable,
          secret.id,
          secret.current_version,
        ],
      );
    }

    return bindings.map(({ variable, secret }) => ({
      variable,
      name: secret.name,
      version: secret.current_version,
    }));
  }

  async bindings(org: string, deployment: string) {
    const exists = await this.control.db.query(
      'SELECT 1 FROM deployments WHERE organisation_id=$1 AND id=$2',
      [org, deployment],
    );

    if (!exists.rowCount) {
      throw new DomainError('NOT_FOUND', 'Deployment not found.', 404);
    }

    return (
      await this.control.db.query(
        `
          SELECT
            b.variable,
            s.name,
            b.version,
            v.revoked_at
          FROM
            deployment_secret_bindings b
            JOIN deployment_secrets s ON s.organisation_id = b.organisation_id
            AND s.id = b.secret_id
            JOIN deployment_secret_versions v ON v.organisation_id = b.organisation_id
            AND v.project_id = b.project_id
            AND v.environment_id = b.environment_id
            AND v.secret_id = b.secret_id
            AND v.version = b.version
          WHERE
            b.organisation_id = $1
            AND b.deployment_id = $2
          ORDER BY
            b.variable
        `,
        [org, deployment],
      )
    ).rows;
  }

  async deliver(tx: Transaction, deployment: ExecutionRequest) {
    const rows = (
      await tx.query<
        Secret & {
          variable: string;
          version: number;
          encrypted_value: unknown;
          revoked_at: string | null;
        }
      >(
        `
          SELECT
            s.*,
            b.variable,
            b.version,
            v.encrypted_value,
            v.revoked_at
          FROM
            deployment_secret_bindings b
            JOIN deployment_secrets s ON s.organisation_id = b.organisation_id
            AND s.id = b.secret_id
            JOIN deployment_secret_versions v ON v.organisation_id = b.organisation_id
            AND v.project_id = b.project_id
            AND v.environment_id = b.environment_id
            AND v.secret_id = b.secret_id
            AND v.version = b.version
          WHERE
            b.organisation_id = $1
            AND b.deployment_id = $2
          ORDER BY
            s.id,
            b.variable
          FOR SHARE OF
            s,
            v
        `,
        [deployment.organisation_id, deployment.id],
      )
    ).rows;

    const values: Record<string, string> = {};

    for (const row of rows) {
      if (row.disabled || row.revoked_at) {
        throw new DomainError(
          'SECRET_UNAVAILABLE',
          'A secret version for this deployment was revoked.',
          409,
        );
      }

      try {
        values[row.variable] = secretValue.parse(
          this.vault().decrypt<string>(
            deployment.organisation_id,
            secretContext(row, row.version),
            row.encrypted_value,
          ),
        );
      } catch {
        throw new DomainError(
          'SECRET_UNAVAILABLE',
          'A secret version for this deployment could not be decrypted.',
          503,
        );
      }
    }

    return { values };
  }
}
