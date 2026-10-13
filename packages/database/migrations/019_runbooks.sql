CREATE TABLE runbooks (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, project_id, environment_id, id),
  UNIQUE (organisation_id, project_id, environment_id, slug),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  FOREIGN KEY (organisation_id, environment_id) REFERENCES environments (organisation_id, id),
  FOREIGN KEY (organisation_id, created_by) REFERENCES actors (organisation_id, id)
);

CREATE TABLE runbook_versions (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  runbook_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  artifact_id uuid NOT NULL,
  manifest jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, project_id, environment_id, id),
  UNIQUE (organisation_id, runbook_id, version),
  FOREIGN KEY (
    organisation_id,
    project_id,
    environment_id,
    runbook_id
  ) REFERENCES runbooks (organisation_id, project_id, environment_id, id),
  FOREIGN KEY (organisation_id, project_id, artifact_id) REFERENCES artifacts (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, created_by) REFERENCES actors (organisation_id, id)
);

CREATE TRIGGER immutable_runbook_versions
BEFORE UPDATE OR DELETE ON runbook_versions FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

ALTER TABLE deployment_targets
ADD CONSTRAINT target_runbook_scope UNIQUE (organisation_id, project_id, environment_id, id);

CREATE TABLE runbook_plans (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  runbook_version_id uuid NOT NULL,
  target_id uuid NOT NULL,
  expected_fence integer NOT NULL CHECK (expected_fence >= 0),
  policy_revision integer NOT NULL,
  requires_approval boolean NOT NULL,
  secret_bindings jsonb NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, project_id, environment_id, id),
  UNIQUE (
    organisation_id,
    project_id,
    environment_id,
    id,
    runbook_version_id
  ),
  FOREIGN KEY (
    organisation_id,
    project_id,
    environment_id,
    runbook_version_id
  ) REFERENCES runbook_versions (organisation_id, project_id, environment_id, id),
  FOREIGN KEY (
    organisation_id,
    project_id,
    environment_id,
    target_id
  ) REFERENCES deployment_targets (organisation_id, project_id, environment_id, id),
  FOREIGN KEY (organisation_id, created_by) REFERENCES actors (organisation_id, id)
);

CREATE TRIGGER immutable_runbook_plans
BEFORE UPDATE OR DELETE ON runbook_plans FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

-- The shared request/attempt tables retain environment locks, leases, secret bindings,
-- certificate recovery and the backup stop barrier for both kinds of work.
ALTER TABLE deployments
ALTER COLUMN release_id
DROP NOT NULL;

ALTER TABLE deployments
DROP CONSTRAINT deployments_kind_check;

ALTER TABLE deployments
ADD CONSTRAINT deployments_kind_check CHECK (kind IN ('deploy', 'rollback', 'runbook'));

ALTER TABLE deployments
ADD COLUMN runbook_version_id uuid,
ADD COLUMN runbook_plan_id uuid,
ADD CONSTRAINT request_runbook_version FOREIGN KEY (
  organisation_id,
  project_id,
  environment_id,
  runbook_version_id
) REFERENCES runbook_versions (organisation_id, project_id, environment_id, id),
ADD CONSTRAINT request_runbook_plan FOREIGN KEY (
  organisation_id,
  project_id,
  environment_id,
  runbook_plan_id,
  runbook_version_id
) REFERENCES runbook_plans (
  organisation_id,
  project_id,
  environment_id,
  id,
  runbook_version_id
),
ADD CONSTRAINT request_work_kind CHECK (
  (
    kind = 'runbook'
    AND release_id IS NULL
    AND runbook_version_id IS NOT NULL
    AND runbook_plan_id IS NOT NULL
    AND promotion_source_deployment_id IS NULL
  )
  OR (
    kind <> 'runbook'
    AND release_id IS NOT NULL
    AND runbook_version_id IS NULL
    AND runbook_plan_id IS NULL
  )
);

CREATE UNIQUE INDEX runbook_plan_once ON deployments (runbook_plan_id)
WHERE
  runbook_plan_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_deployment_admission () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.organisation_id, NEW.project_id, NEW.release_id, NEW.environment_id,
         NEW.requested_by, NEW.kind, NEW.promotion_source_deployment_id,
         NEW.policy_snapshot, NEW.rollback_plan_id, NEW.runbook_version_id, NEW.runbook_plan_id)
     IS DISTINCT FROM
     ROW(OLD.organisation_id, OLD.project_id, OLD.release_id, OLD.environment_id,
         OLD.requested_by, OLD.kind, OLD.promotion_source_deployment_id,
         OLD.policy_snapshot, OLD.rollback_plan_id, OLD.runbook_version_id, OLD.runbook_plan_id) THEN
    RAISE EXCEPTION 'Execution admission is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_runbook_identity () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.organisation_id, NEW.project_id, NEW.environment_id, NEW.name, NEW.slug, NEW.description, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.organisation_id, OLD.project_id, OLD.environment_id, OLD.name, OLD.slug, OLD.description, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Runbook identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER immutable_runbook_identity
BEFORE UPDATE ON runbooks FOR EACH ROW
EXECUTE FUNCTION protect_runbook_identity ();

CREATE VIEW runbook_runs AS
SELECT
  *
FROM
  deployments
WHERE
  kind = 'runbook';

ALTER TABLE deployment_attempts
DROP CONSTRAINT deployment_attempts_phase_check;

ALTER TABLE deployment_attempts
ADD CONSTRAINT deployment_attempts_phase_check CHECK (
  phase IN (
    'waiting',
    'downloading',
    'loading_image',
    'replacing_container',
    'starting_candidate',
    'pre_hook',
    'post_hook',
    'runbook_task',
    'verifying_http',
    'switching_traffic',
    'cleaning_up'
  )
);

CREATE INDEX runbooks_resource_page ON runbooks (organisation_id, created_at DESC, id DESC);

CREATE INDEX runbook_versions_resource_page ON runbook_versions (organisation_id, created_at DESC, id DESC);

CREATE INDEX runbook_versions_history ON runbook_versions (
  organisation_id,
  runbook_id,
  created_at DESC,
  id DESC
);

CREATE INDEX runbook_runs_resource_page ON deployments (organisation_id, created_at DESC, id DESC)
WHERE
  kind = 'runbook';
