ALTER TABLE api_tokens
DROP CONSTRAINT api_tokens_permissions_check;

ALTER TABLE api_tokens
ADD CONSTRAINT api_tokens_permissions_check CHECK (
  permissions <@ ARRAY['read', 'write', 'approve', 'manage_secrets']::TEXT[]
);

CREATE TABLE deployment_secrets (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  disabled boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, project_id, environment_id, name),
  UNIQUE (organisation_id, project_id, environment_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  FOREIGN KEY (organisation_id, environment_id) REFERENCES environments (organisation_id, id)
);

CREATE TABLE deployment_secret_versions (
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  secret_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  encrypted_value jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (
    organisation_id,
    project_id,
    environment_id,
    secret_id,
    version
  ),
  FOREIGN KEY (
    organisation_id,
    project_id,
    environment_id,
    secret_id
  ) REFERENCES deployment_secrets (organisation_id, project_id, environment_id, id),
  FOREIGN KEY (organisation_id, created_by) REFERENCES actors (organisation_id, id)
);

ALTER TABLE deployments
ADD CONSTRAINT deployment_secret_scope UNIQUE (organisation_id, project_id, environment_id, id);

CREATE TABLE deployment_secret_bindings (
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  variable text NOT NULL CHECK (variable ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  secret_id uuid NOT NULL,
  version integer NOT NULL,
  PRIMARY KEY (organisation_id, deployment_id, variable),
  FOREIGN KEY (
    organisation_id,
    project_id,
    environment_id,
    deployment_id
  ) REFERENCES deployments (organisation_id, project_id, environment_id, id),
  FOREIGN KEY (
    organisation_id,
    project_id,
    environment_id,
    secret_id,
    version
  ) REFERENCES deployment_secret_versions (
    organisation_id,
    project_id,
    environment_id,
    secret_id,
    version
  )
);

CREATE TRIGGER immutable_secret_bindings
BEFORE UPDATE OR DELETE ON deployment_secret_bindings FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

CREATE FUNCTION protect_secret_version () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Secret version history is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.organisation_id, NEW.project_id, NEW.environment_id, NEW.secret_id,
         NEW.version, NEW.encrypted_value, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.organisation_id, OLD.project_id, OLD.environment_id, OLD.secret_id,
         OLD.version, OLD.encrypted_value, OLD.created_by, OLD.created_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Secret versions can only be revoked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER immutable_secret_versions
BEFORE UPDATE OR DELETE ON deployment_secret_versions FOR EACH ROW
EXECUTE FUNCTION protect_secret_version ();

ALTER TABLE deployment_secrets
ADD CONSTRAINT current_secret_version FOREIGN KEY (
  organisation_id,
  project_id,
  environment_id,
  id,
  current_version
) REFERENCES deployment_secret_versions (
  organisation_id,
  project_id,
  environment_id,
  secret_id,
  version
)
DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION protect_secret_identity () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.organisation_id, NEW.project_id, NEW.environment_id, NEW.name)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organisation_id, OLD.project_id, OLD.environment_id, OLD.name) THEN
    RAISE EXCEPTION 'Secret scope and name are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER immutable_secret_identity
BEFORE UPDATE ON deployment_secrets FOR EACH ROW
EXECUTE FUNCTION protect_secret_identity ();

ALTER TABLE rollback_plans
ADD COLUMN secret_bindings jsonb NOT NULL DEFAULT '[]';
