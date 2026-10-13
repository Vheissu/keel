CREATE TABLE workspace_roles (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  permissions TEXT[] NOT NULL CHECK (
    permissions <@ ARRAY['read', 'write', 'approve', 'manage_secrets']::TEXT[]
    AND 'read' = ANY (permissions)
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);

CREATE UNIQUE INDEX workspace_roles_name ON workspace_roles (organisation_id, lower(name))
WHERE
  archived_at IS NULL;

ALTER TABLE memberships
DROP CONSTRAINT memberships_role_check;

ALTER TABLE memberships
ADD COLUMN custom_role_id uuid GENERATED ALWAYS AS (
  CASE
    WHEN role IN (
      'owner',
      'admin',
      'operator',
      'approver',
      'secret_manager',
      'reader'
    ) THEN NULL
    ELSE role::uuid
  END
) STORED;

ALTER TABLE memberships
ADD FOREIGN KEY (organisation_id, custom_role_id) REFERENCES workspace_roles (organisation_id, id);

ALTER TABLE workspace_invitations
DROP CONSTRAINT workspace_invitations_role_check;

ALTER TABLE workspace_invitations
ADD COLUMN custom_role_id uuid GENERATED ALWAYS AS (
  CASE
    WHEN role IN (
      'owner',
      'admin',
      'operator',
      'approver',
      'secret_manager',
      'reader'
    ) THEN NULL
    ELSE role::uuid
  END
) STORED;

ALTER TABLE workspace_invitations
ADD FOREIGN KEY (organisation_id, custom_role_id) REFERENCES workspace_roles (organisation_id, id);

ALTER TABLE api_tokens
ADD COLUMN project_ids UUID[] CHECK (
  project_ids IS NULL
  OR cardinality(project_ids) BETWEEN 1 AND 100
);
