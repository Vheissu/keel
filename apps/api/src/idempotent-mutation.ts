import type { FastifyRequest } from 'fastify';
import type { Transaction } from '../../../packages/database/src/index.js';
import { requirePermission, type Permission } from '../../../packages/domain/src/index.js';
import { sha256 } from './artifact-store.js';
import type { ControlPlane } from './control-plane.js';

// Checks the permission, then runs work once per Idempotency-Key for this request fingerprint.
export function idempotentMutation<T>(
  control: ControlPlane,
  req: FastifyRequest,
  fingerprint: string,
  work: (tx: Transaction) => Promise<T>,
  permission: Exclude<Permission, 'read'> = 'write',
) {
  requirePermission(req.principal, permission);

  return control.mutate(
    req.principal,
    String(req.headers['idempotency-key'] ?? ''),
    sha256(fingerprint),
    work,
  );
}
