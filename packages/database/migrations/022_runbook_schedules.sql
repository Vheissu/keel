ALTER TABLE runbook_versions
ADD CONSTRAINT runbook_versions_runbook_id UNIQUE (organisation_id, runbook_id, id);

-- A schedule repeats the version, target, input values, policy revision and secret versions of
-- the review it was created from. Each occurrence records its own immutable review snapshot.
CREATE TABLE runbook_schedules (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  runbook_id uuid NOT NULL,
  runbook_version_id uuid NOT NULL,
  source_plan_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  cron text NOT NULL CHECK (char_length(cron) BETWEEN 9 AND 100),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  created_by uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT TRUE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_run_at timestamptz,
  paused_code text,
  last_scheduled_for timestamptz,
  last_result_code text,
  last_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, project_id, environment_id, id),
  UNIQUE (
    organisation_id,
    project_id,
    environment_id,
    id,
    runbook_version_id
  ),
  CHECK (
    enabled = (next_run_at IS NOT NULL)
    AND (
      NOT enabled
      OR paused_code IS NULL
    )
  ),
  FOREIGN KEY (
    organisation_id,
    project_id,
    environment_id,
    source_plan_id,
    runbook_version_id
  ) REFERENCES runbook_plans (
    organisation_id,
    project_id,
    environment_id,
    id,
    runbook_version_id
  ),
  FOREIGN KEY (organisation_id, runbook_id, runbook_version_id) REFERENCES runbook_versions (organisation_id, runbook_id, id),
  FOREIGN KEY (organisation_id, created_by) REFERENCES actors (organisation_id, id),
  FOREIGN KEY (organisation_id, last_run_id) REFERENCES deployments (organisation_id, id)
);

CREATE FUNCTION protect_runbook_schedule () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.organisation_id, NEW.project_id, NEW.environment_id, NEW.runbook_id,
         NEW.runbook_version_id, NEW.source_plan_id, NEW.name, NEW.cron, NEW.time_zone,
         NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organisation_id, OLD.project_id, OLD.environment_id, OLD.runbook_id,
         OLD.runbook_version_id, OLD.source_plan_id, OLD.name, OLD.cron, OLD.time_zone,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Runbook schedule definitions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER immutable_runbook_schedule
BEFORE UPDATE ON runbook_schedules FOR EACH ROW
EXECUTE FUNCTION protect_runbook_schedule ();

CREATE TRIGGER retained_runbook_schedule
BEFORE DELETE ON runbook_schedules FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

ALTER TABLE runbook_plans
ADD COLUMN schedule_id uuid,
ADD COLUMN scheduled_for timestamptz,
ADD CONSTRAINT runbook_plan_occurrence CHECK ((schedule_id IS NULL) = (scheduled_for IS NULL)),
ADD CONSTRAINT runbook_plan_schedule FOREIGN KEY (
  organisation_id,
  project_id,
  environment_id,
  schedule_id,
  runbook_version_id
) REFERENCES runbook_schedules (
  organisation_id,
  project_id,
  environment_id,
  id,
  runbook_version_id
);

CREATE UNIQUE INDEX runbook_schedule_occurrence ON runbook_plans (schedule_id, scheduled_for)
WHERE
  schedule_id IS NOT NULL;

CREATE INDEX runbook_schedules_due ON runbook_schedules (next_run_at, id)
WHERE
  enabled;

CREATE INDEX runbook_schedules_resource_page ON runbook_schedules (organisation_id, created_at DESC, id DESC);

DROP VIEW runbook_runs;

CREATE VIEW runbook_runs AS
SELECT
  d.*,
  plan.schedule_id AS runbook_schedule_id,
  plan.scheduled_for
FROM
  deployments d
  JOIN runbook_plans plan ON plan.organisation_id = d.organisation_id
  AND plan.id = d.runbook_plan_id
WHERE
  d.kind = 'runbook';
