import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../../packages/database/src/index.js';
import type { Principal } from '../../../packages/domain/src/index.js';

export async function auditEvent(
  tx: Transaction,
  p: Principal,
  action: string,
  resource: string,
  details: object = {},
) {
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
        ($1, $2, $3, $4, $5, $6)
    `,
    [randomUUID(), p.organisation_id, p.actor_id, action, resource, details],
  );
}
