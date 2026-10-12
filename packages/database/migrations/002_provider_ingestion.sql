CREATE TABLE provider_connections (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_by uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'github-actions'),
  name text NOT NULL,
  repository text NOT NULL,
  repository_id text NOT NULL,
  workflow_id text NOT NULL,
  branch text NOT NULL,
  artifact_name text NOT NULL,
  credentials jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT TRUE,
  credential_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  FOREIGN KEY (organisation_id, created_by) REFERENCES actors (organisation_id, id)
);

CREATE TABLE provider_webhook_deliveries (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  delivery_id text NOT NULL,
  event text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'ignored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, delivery_id),
  FOREIGN KEY (organisation_id, connection_id) REFERENCES provider_connections (organisation_id, id)
);

CREATE TABLE artifact_imports (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  run_id text NOT NULL,
  run_attempt integer NOT NULL CHECK (run_attempt > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'succeeded', 'failed')
  ),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  artifact_id uuid,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, run_id, run_attempt),
  FOREIGN KEY (organisation_id, project_id, connection_id) REFERENCES provider_connections (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, project_id, artifact_id) REFERENCES artifacts (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, requested_by) REFERENCES actors (organisation_id, id),
  CHECK (
    (status = 'succeeded') = (artifact_id IS NOT NULL)
  ),
  CHECK (
    (status = 'processing') = (
      lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  )
);

CREATE INDEX artifact_imports_pending ON artifact_imports (available_at, created_at)
WHERE
  status IN ('pending', 'processing');

CREATE INDEX provider_connections_org ON provider_connections (organisation_id, created_at DESC);

CREATE TRIGGER immutable_provider_deliveries
BEFORE UPDATE OR DELETE ON provider_webhook_deliveries FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();
