import { randomUUID, randomBytes } from 'node:crypto';
import type { Database } from '../packages/database/src/index.js';
import { sha256 } from '../apps/api/src/artifact-store.js';

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL || 'postgres://keel:keel-local-only@127.0.0.1:55439/keel';

export async function fixture(db: Database) {
  const org = randomUUID();

  await db.query('INSERT INTO organisations(id,name) VALUES($1,$2)', [org, 'Test workspace']);
  const identities: Record<string, { id: string; token: string }> = {};

  for (const [name, permissions] of [
    ['operator', ['read', 'write']],
    ['approver', ['read', 'approve']],
    ['reader', ['read']],
  ] as const) {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');

    await db.query('INSERT INTO actors(id,organisation_id,name) VALUES($1,$2,$3)', [id, org, name]);

    await db.query(
      `
        INSERT INTO
          api_tokens (
            id,
            organisation_id,
            actor_id,
            token_hash,
            permissions
          )
        VALUES
          ($1, $2, $3, $4, $5)
      `,
      [randomUUID(), org, id, sha256(token), permissions],
    );

    identities[name] = { id, token };
  }

  const environments: Record<string, string> = {};

  for (const [slug, approval] of [
    ['staging', false],
    ['production', true],
  ] as const) {
    const id = randomUUID();

    environments[slug] = id;

    await db.query(
      `
        INSERT INTO
          environments (
            id,
            organisation_id,
            name,
            slug,
            requires_approval
          )
        VALUES
          ($1, $2, $3, $4, $5)
      `,
      [id, org, slug[0].toUpperCase() + slug.slice(1), slug, approval],
    );
  }

  return { org, ...identities, environments } as {
    org: string;
    operator: { id: string; token: string };
    approver: { id: string; token: string };
    reader: { id: string; token: string };
    environments: Record<string, string>;
  };
}

export function deploymentProcess(approval = true) {
  return {
    apiVersion: 'keel.dev/v1alpha1',
    kind: 'DeploymentProcess',
    metadata: { name: 'application' },
    spec: {
      artifact: { source: 'release', name: 'application' },
      environments: {
        staging: { strategy: 'rolling', targetSelector: { labels: { tier: 'staging' } } },
        production: {
          strategy: 'rolling',
          requiresApproval: approval,
          targetSelector: { labels: { tier: 'production' } },
        },
      },
    },
  };
}
