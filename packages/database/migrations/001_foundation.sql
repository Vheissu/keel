CREATE TABLE organisations (id uuid PRIMARY KEY, name text NOT NULL);

CREATE TABLE actors (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL,
  UNIQUE (organisation_id, id)
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  permissions TEXT[] NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organisation_id, actor_id) REFERENCES actors (organisation_id, id),
  CHECK (
    permissions <@ ARRAY['read', 'write', 'approve']::TEXT[]
  )
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, slug)
);

CREATE TABLE environments (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL,
  slug text NOT NULL,
  requires_approval boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, slug)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  size integer NOT NULL CHECK (size > 0),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, project_id, id),
  UNIQUE (organisation_id, project_id, name, version),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id)
);

CREATE TABLE releases (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version text NOT NULL,
  artifact_id uuid NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, project_id, id),
  UNIQUE (organisation_id, project_id, version),
  FOREIGN KEY (organisation_id, project_id, artifact_id) REFERENCES artifacts (organisation_id, project_id, id)
);

CREATE TABLE deployments (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'awaiting_approval',
      'queued',
      'cancelled',
      'rejected'
    )
  ),
  requested_by uuid NOT NULL,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id, release_id) REFERENCES releases (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, environment_id) REFERENCES environments (organisation_id, id),
  FOREIGN KEY (organisation_id, requested_by) REFERENCES actors (organisation_id, id),
  FOREIGN KEY (organisation_id, approved_by) REFERENCES actors (organisation_id, id),
  CHECK (
    approved_by IS NULL
    OR approved_by <> requested_by
  )
);

CREATE UNIQUE INDEX deployment_environment_lock ON deployments (organisation_id, project_id, environment_id)
WHERE
  status IN ('awaiting_approval', 'queued');

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  resource_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organisation_id, actor_id) REFERENCES actors (organisation_id, id)
);

CREATE TABLE deployment_events (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  status text NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organisation_id, deployment_id) REFERENCES deployments (organisation_id, id),
  FOREIGN KEY (organisation_id, actor_id) REFERENCES actors (organisation_id, id)
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE TABLE idempotency_keys (
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  actor_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, actor_id, key),
  FOREIGN KEY (organisation_id, actor_id) REFERENCES actors (organisation_id, id)
);

CREATE INDEX audit_org_time ON audit_events (organisation_id, created_at DESC, id DESC);

CREATE INDEX outbox_pending ON outbox (created_at)
WHERE
  delivered_at IS NULL;

CREATE INDEX deployments_org_time ON deployments (organisation_id, created_at DESC);

CREATE FUNCTION reject_immutable_change () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable records cannot be modified'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER immutable_releases
BEFORE UPDATE OR DELETE ON releases FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

CREATE TRIGGER immutable_artifacts
BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

CREATE TRIGGER immutable_audit
BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

CREATE TRIGGER immutable_deployment_events
BEFORE UPDATE OR DELETE ON deployment_events FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();
