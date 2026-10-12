ALTER TABLE provider_connections
DROP CONSTRAINT provider_connections_provider_check;

ALTER TABLE provider_connections
ADD CONSTRAINT provider_connections_provider_check CHECK (
  provider IN ('github-actions', 'bitbucket-pipelines')
);

ALTER TABLE artifact_imports
ADD COLUMN candidate_digest text,
ADD COLUMN candidate_commit text,
ADD COLUMN candidate_step_id text,
ADD CONSTRAINT candidate_complete CHECK (
  (
    candidate_digest IS NULL
    AND candidate_commit IS NULL
    AND candidate_step_id IS NULL
  )
  OR (
    candidate_digest IS NOT NULL
    AND candidate_commit IS NOT NULL
    AND candidate_digest ~ '^[a-f0-9]{64}$'
    AND candidate_commit ~ '^[a-f0-9]{40}$'
    AND candidate_step_id IS NOT NULL
  )
);

CREATE FUNCTION protect_import_source () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.organisation_id,
    NEW.project_id,
    NEW.connection_id,
    NEW.requested_by,
    NEW.run_id,
    NEW.run_attempt,
    NEW.candidate_digest,
    NEW.candidate_commit,
    NEW.candidate_step_id,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id,
    OLD.project_id,
    OLD.connection_id,
    OLD.requested_by,
    OLD.run_id,
    OLD.run_attempt,
    OLD.candidate_digest,
    OLD.candidate_commit,
    OLD.candidate_step_id,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Import source is immutable';
  END IF;

  RETURN NEW;
END;

$$;

CREATE TRIGGER immutable_import_source
BEFORE UPDATE ON artifact_imports FOR EACH ROW
EXECUTE FUNCTION protect_import_source ();
