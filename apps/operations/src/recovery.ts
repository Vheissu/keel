import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { transaction, type Database } from '../../../packages/database/src/index.js';
import { CredentialVault } from '../../api/src/credential-vault.js';
import { secretContext } from '../../api/src/deployment-secrets.js';
import { artifactStore } from '../../api/src/storage-config.js';
import { OperationError } from './operation-error.js';

export async function quiescent(db: Database) {
  const result = await db.query(`
    SELECT
      (
        SELECT
          count(*)::int
        FROM
          deployments
        WHERE
          status IN (
            'queued',
            'running',
            'cancel_requested',
            'reconciliation_required'
          )
      ) AS deployments,
      (
        SELECT
          count(*)::int
        FROM
          deployment_attempts
        WHERE
          state IN (
            'ready',
            'running',
            'reconciling',
            'reconciliation_required'
          )
      ) AS attempts,
      (
        SELECT
          count(*)::int
        FROM
          artifact_imports
        WHERE
          status = 'processing'
      ) AS imports
  `);

  const counts = result.rows[0];

  if (Object.values(counts).some((value) => value !== 0)) {
    throw new OperationError('Wait for active work and reconciliation before taking a backup.');
  }

  return counts;
}

export async function verify(db: Database) {
  const expected = (
    await readdir(new URL('../../../packages/database/migrations/', import.meta.url))
  )
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(
    (row) => row.name,
  );

  if (JSON.stringify(expected) !== JSON.stringify(applied)) {
    throw new OperationError('The database and image have different migration versions.');
  }

  const store = artifactStore();
  const artifacts = (await db.query('SELECT organisation_id, digest FROM artifacts')).rows;

  for (const artifact of artifacts) {
    await store.get(artifact.organisation_id, artifact.digest);
  }

  const credentialVault = new CredentialVault(process.env.KEEL_CREDENTIAL_KEY!);

  const secretVault = new CredentialVault(
    process.env.KEEL_DEPLOYMENT_SECRET_KEY!,
    'deployment-secrets',
  );

  const connections = (
    await db.query('SELECT organisation_id, id, credentials FROM provider_connections')
  ).rows;

  for (const connection of connections) {
    credentialVault.decrypt(connection.organisation_id, connection.id, connection.credentials);
  }

  const notificationVault = new CredentialVault(process.env.KEEL_CREDENTIAL_KEY!, 'notifications');

  const endpoints = (
    await db.query('SELECT organisation_id, id, credentials FROM notification_endpoints')
  ).rows;

  for (const endpoint of endpoints) {
    notificationVault.decrypt(endpoint.organisation_id, endpoint.id, endpoint.credentials);
  }

  const secrets = (
    await db.query(`
      SELECT
        s.organisation_id,
        s.project_id,
        s.environment_id,
        s.id,
        s.name,
        v.version,
        v.encrypted_value
      FROM
        deployment_secrets s
        JOIN deployment_secret_versions v ON s.organisation_id = v.organisation_id
        AND s.id = v.secret_id
    `)
  ).rows;

  for (const secret of secrets) {
    secretVault.decrypt(
      secret.organisation_id,
      secretContext(secret, secret.version),
      secret.encrypted_value,
    );
  }

  return {
    migrations: applied.length,
    artifacts: artifacts.length,
    connections: connections.length,
    notification_endpoints: endpoints.length,
    secret_versions: secrets.length,
  };
}

export async function quarantine(db: Database) {
  return transaction(db, async (tx) => {
    const organisations = (await tx.query('SELECT id FROM organisations')).rows;

    await tx.query('UPDATE browser_sessions SET revoked_at=now() WHERE revoked_at IS NULL');

    await tx.query(
      `
        UPDATE api_tokens
        SET
          revoked_at = now()
        WHERE
          user_id IS NOT NULL
          AND revoked_at IS NULL
      `,
    );

    await tx.query(
      `
        UPDATE workspace_invitations
        SET
          revoked_at = now()
        WHERE
          accepted_at IS NULL
          AND revoked_at IS NULL
      `,
    );

    await tx.query('UPDATE password_resets SET used_at=now() WHERE used_at IS NULL');

    // Restored deliveries may already have reached receivers after the backup was taken.
    await tx.query(
      'UPDATE notification_endpoints SET enabled=false, revision=revision+1 WHERE enabled',
    );

    await tx.query(
      `
        UPDATE notification_attempts
        SET
          code = 'RESTORE_QUARANTINE',
          completed_at = now()
        WHERE
          completed_at IS NULL
      `,
    );

    await tx.query(
      `
        UPDATE notification_deliveries
        SET
          status = 'cancelled',
          last_code = 'RESTORE_QUARANTINE',
          lease_id = NULL,
          lease_expires_at = NULL
        WHERE
          status IN ('pending', 'retrying', 'sending')
      `,
    );

    const agents = await tx.query(
      "UPDATE deployment_agents SET state='revoked' WHERE state <> 'revoked'",
    );

    const targets = await tx.query(
      `
        UPDATE deployment_targets
        SET
          current_state = 'unknown',
          current_release_id = NULL
        WHERE
          current_state <> 'unknown'
          OR current_release_id IS NOT NULL
      `,
    );

    for (const org of organisations) {
      const actor = randomUUID();

      await tx.query('INSERT INTO actors(id, organisation_id, name) VALUES($1, $2, $3)', [
        actor,
        org.id,
        'Installation recovery',
      ]);

      await tx.query(
        `
          INSERT INTO
            audit_events (
              id,
              organisation_id,
              actor_id,
              action,
              resource_id,
              details
            )
          VALUES
            ($1, $2, $3, 'installation.restored', $2, $4)
        `,
        [
          randomUUID(),
          org.id,
          actor,
          JSON.stringify({ agents_revoked: agents.rowCount, targets_unknown: targets.rowCount }),
        ],
      );
    }

    return { agents_revoked: agents.rowCount, targets_unknown: targets.rowCount };
  });
}
