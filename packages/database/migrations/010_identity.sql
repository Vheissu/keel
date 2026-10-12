CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  actor_id uuid NOT NULL,
  role text NOT NULL CHECK (
    role IN (
      'owner',
      'admin',
      'operator',
      'approver',
      'secret_manager',
      'reader'
    )
  ),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id),
  UNIQUE (organisation_id, actor_id),
  FOREIGN KEY (organisation_id, actor_id) REFERENCES actors (organisation_id, id)
);

CREATE TABLE browser_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX browser_sessions_user ON browser_sessions (user_id);

CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (
    role IN (
      'owner',
      'admin',
      'operator',
      'approver',
      'secret_manager',
      'reader'
    )
  ),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_invitations_workspace ON workspace_invitations (organisation_id, created_at, id);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

ALTER TABLE api_tokens
ADD COLUMN user_id uuid REFERENCES users (id);

ALTER TABLE api_tokens
ADD COLUMN name text;

ALTER TABLE api_tokens
ADD COLUMN expires_at timestamptz;

ALTER TABLE api_tokens
ADD CONSTRAINT managed_token_fields CHECK (
  user_id IS NULL
  OR (
    name IS NOT NULL
    AND expires_at IS NOT NULL
  )
);

ALTER TABLE api_tokens
ADD CONSTRAINT managed_token_membership FOREIGN KEY (organisation_id, user_id) REFERENCES memberships (organisation_id, user_id);

CREATE INDEX managed_tokens_workspace ON api_tokens (organisation_id, user_id, created_at, id);

CREATE TABLE login_attempts (
  subject_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0)
);

CREATE INDEX login_attempts_cleanup ON login_attempts (window_start);
