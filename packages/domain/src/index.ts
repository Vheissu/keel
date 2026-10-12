export type Permission = 'read' | 'write' | 'approve' | 'manage_secrets';

export interface Principal {
  organisation_id: string;
  actor_id: string;
  name: string;
  permissions: Permission[];
}

export interface Project {
  id: string;
  organisation_id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
}

export interface Environment {
  id: string;
  organisation_id: string;
  name: string;
  slug: string;
  requires_approval: boolean;
  promotion_from_environment_id: string | null;
  policy_revision: number;
  created_at: string;
}

export interface Artifact {
  id: string;
  organisation_id: string;
  project_id: string;
  name: string;
  version: string;
  digest: string;
  size: number;
  provenance: Record<string, unknown>;
  created_at: string;
}

export interface Release {
  id: string;
  organisation_id: string;
  project_id: string;
  version: string;
  artifact_id: string;
  manifest: ReleaseManifest;
  created_at: string;
}

export interface ReleaseManifest {
  schema_version: 1;
  artifact: { id: string; name: string; digest: string; size: number };
  process: unknown;
  provenance: Record<string, unknown>;
}

export type DeploymentStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'reconciliation_required'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export interface Deployment {
  id: string;
  organisation_id: string;
  project_id: string;
  release_id: string;
  environment_id: string;
  status: DeploymentStatus;
  kind: 'deploy' | 'rollback';
  promotion_source_deployment_id: string | null;
  policy_snapshot: {
    revision?: number;
    promotion_from_environment_id?: string | null;
    requires_approval?: boolean;
  };
  rollback_plan_id: string | null;
  result_code: string | null;
  requested_by: string;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor_id: string;
  resource_id: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Snapshot {
  organisation: { id: string; name: string };
  principal: Principal;
  projects: Project[];
  environments: Environment[];
  artifacts: Artifact[];
  releases: Release[];
  deployments: Deployment[];
  audit: AuditEvent[];
}

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function requirePermission(principal: Principal, permission: Permission) {
  if (!principal.permissions.includes(permission)) {
    throw new DomainError('FORBIDDEN', `This token requires ${permission} permission.`, 403);
  }
}

export function approveDeployment(deployment: Deployment, principal: Principal): void {
  requirePermission(principal, 'approve');

  if (deployment.status !== 'awaiting_approval') {
    throw new DomainError(
      'INVALID_STATE',
      'Only a deployment awaiting approval can be approved.',
      409,
    );
  }

  if (deployment.requested_by === principal.actor_id) {
    throw new DomainError('SELF_APPROVAL', 'A different person must approve this deployment.', 403);
  }
}
