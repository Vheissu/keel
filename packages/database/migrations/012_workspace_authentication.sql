CREATE TABLE workspace_auth_policies (
  organisation_id uuid PRIMARY KEY REFERENCES organisations (id),
  require_sso boolean NOT NULL DEFAULT FALSE,
  require_mfa boolean NOT NULL DEFAULT FALSE,
  allow_api_tokens boolean NOT NULL DEFAULT TRUE,
  session_minutes integer NOT NULL DEFAULT 720 CHECK (session_minutes BETWEEN 15 AND 720)
);

CREATE TABLE sso_connections (
  organisation_id uuid PRIMARY KEY REFERENCES organisations (id),
  id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sso_identities (
  connection_id uuid NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  PRIMARY KEY (connection_id, subject),
  UNIQUE (connection_id, user_id)
);

ALTER TABLE browser_sessions
ADD COLUMN sso_connection_id uuid;

ALTER TABLE mfa_challenges
ADD COLUMN sso_connection_id uuid;

CREATE TABLE sso_attempts (
  state_hash text PRIMARY KEY,
  binding_hash text NOT NULL,
  connection_id uuid NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  proof jsonb NOT NULL,
  session_id uuid REFERENCES browser_sessions (id),
  expires_at timestamptz NOT NULL
);

CREATE INDEX sso_attempts_expiry ON sso_attempts (expires_at);

ALTER TABLE browser_sessions
ADD COLUMN authenticated_at timestamptz;

UPDATE browser_sessions
SET
  authenticated_at = created_at;

ALTER TABLE browser_sessions
ALTER COLUMN authenticated_at
SET NOT NULL;

ALTER TABLE browser_sessions
ALTER COLUMN authenticated_at
SET DEFAULT now();
