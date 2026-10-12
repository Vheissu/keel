ALTER TABLE deployments
DROP CONSTRAINT deployments_status_check;

ALTER TABLE deployments
ADD CONSTRAINT deployments_status_check CHECK (
  status IN (
    'awaiting_approval',
    'queued',
    'running',
    'cancel_requested',
    'reconciliation_required',
    'succeeded',
    'failed',
    'cancelled',
    'rejected'
  )
);

ALTER TABLE deployments
ADD COLUMN result_code text;

DROP INDEX deployment_environment_lock;

CREATE UNIQUE INDEX deployment_environment_lock ON deployments (organisation_id, project_id, environment_id)
WHERE
  status IN (
    'awaiting_approval',
    'queued',
    'running',
    'cancel_requested',
    'reconciliation_required'
  );

CREATE TABLE deployment_agents (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL,
  certificate_fingerprint text NOT NULL UNIQUE CHECK (certificate_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'draining', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);

CREATE TABLE deployment_targets (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  name text NOT NULL,
  labels jsonb NOT NULL,
  capability text NOT NULL DEFAULT 'docker-recreate-v1' CHECK (capability = 'docker-recreate-v1'),
  fence integer NOT NULL DEFAULT 0,
  current_release_id uuid,
  current_state text NOT NULL DEFAULT 'unknown' CHECK (current_state IN ('unknown', 'verified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  FOREIGN KEY (organisation_id, environment_id) REFERENCES environments (organisation_id, id),
  FOREIGN KEY (organisation_id, agent_id) REFERENCES deployment_agents (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id, current_release_id) REFERENCES releases (organisation_id, project_id, id)
);

CREATE TABLE deployment_attempts (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  target_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'ready',
      'running',
      'reconciliation_required',
      'reconciling',
      'succeeded',
      'failed',
      'cancelled'
    )
  ),
  fence integer NOT NULL DEFAULT 0,
  lease_hash text,
  lease_expires_at timestamptz,
  deadline_at timestamptz,
  result_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, deployment_id),
  FOREIGN KEY (organisation_id, deployment_id) REFERENCES deployments (organisation_id, id),
  FOREIGN KEY (organisation_id, target_id) REFERENCES deployment_targets (organisation_id, id),
  FOREIGN KEY (organisation_id, agent_id) REFERENCES deployment_agents (organisation_id, id)
);

CREATE UNIQUE INDEX deployment_target_lock ON deployment_attempts (target_id)
WHERE
  state IN (
    'ready',
    'running',
    'reconciliation_required',
    'reconciling'
  );

CREATE INDEX deployment_agent_work ON deployment_attempts (agent_id, state);
