ALTER TABLE environments
ADD COLUMN promotion_from_environment_id uuid,
ADD COLUMN policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
ADD CONSTRAINT environment_promotion_source FOREIGN KEY (organisation_id, promotion_from_environment_id) REFERENCES environments (organisation_id, id),
ADD CONSTRAINT environment_promotion_not_self CHECK (promotion_from_environment_id <> id);

UPDATE environments production
SET
  promotion_from_environment_id = staging.id
FROM
  environments staging
WHERE
  production.organisation_id = staging.organisation_id
  AND production.slug = 'production'
  AND staging.slug = 'staging';

CREATE TABLE rollback_plans (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  source_deployment_id uuid NOT NULL,
  candidate_deployment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  target_id uuid NOT NULL,
  expected_fence integer NOT NULL CHECK (expected_fence > 0),
  policy_revision integer NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  FOREIGN KEY (organisation_id, environment_id) REFERENCES environments (organisation_id, id),
  FOREIGN KEY (organisation_id, source_deployment_id) REFERENCES deployments (organisation_id, id),
  FOREIGN KEY (organisation_id, candidate_deployment_id) REFERENCES deployments (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id, release_id) REFERENCES releases (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, target_id) REFERENCES deployment_targets (organisation_id, id),
  FOREIGN KEY (organisation_id, created_by) REFERENCES actors (organisation_id, id)
);

CREATE TRIGGER immutable_rollback_plans
BEFORE UPDATE OR DELETE ON rollback_plans FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();

ALTER TABLE deployments
ADD COLUMN kind text NOT NULL DEFAULT 'deploy' CHECK (kind IN ('deploy', 'rollback')),
ADD COLUMN promotion_source_deployment_id uuid,
ADD COLUMN policy_snapshot jsonb NOT NULL DEFAULT '{}',
ADD COLUMN rollback_plan_id uuid,
ADD CONSTRAINT deployment_promotion_evidence FOREIGN KEY (organisation_id, promotion_source_deployment_id) REFERENCES deployments (organisation_id, id),
ADD CONSTRAINT deployment_rollback_plan FOREIGN KEY (organisation_id, rollback_plan_id) REFERENCES rollback_plans (organisation_id, id),
ADD CONSTRAINT deployment_rollback_kind CHECK (
  (kind = 'rollback') = (rollback_plan_id IS NOT NULL)
);

CREATE UNIQUE INDEX rollback_plan_once ON deployments (rollback_plan_id)
WHERE
  rollback_plan_id IS NOT NULL;

CREATE FUNCTION protect_deployment_admission () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.organisation_id, NEW.project_id, NEW.release_id, NEW.environment_id,
         NEW.requested_by, NEW.kind, NEW.promotion_source_deployment_id,
         NEW.policy_snapshot, NEW.rollback_plan_id)
     IS DISTINCT FROM
     ROW(OLD.organisation_id, OLD.project_id, OLD.release_id, OLD.environment_id,
         OLD.requested_by, OLD.kind, OLD.promotion_source_deployment_id,
         OLD.policy_snapshot, OLD.rollback_plan_id) THEN
    RAISE EXCEPTION 'Deployment admission is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER immutable_deployment_admission
BEFORE UPDATE ON deployments FOR EACH ROW
EXECUTE FUNCTION protect_deployment_admission ();

CREATE INDEX deployment_promotion_history ON deployments (organisation_id, release_id, environment_id)
WHERE
  status = 'succeeded';
