ALTER TABLE users
ADD COLUMN mfa_secret jsonb;

ALTER TABLE users
ADD COLUMN mfa_enabled_at timestamptz;

ALTER TABLE users
ADD COLUMN mfa_last_step bigint;

ALTER TABLE browser_sessions
ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE browser_sessions
ADD COLUMN user_agent text NOT NULL DEFAULT '';

ALTER TABLE browser_sessions
ADD COLUMN ip_address text NOT NULL DEFAULT '';

ALTER TABLE browser_sessions
ADD COLUMN mfa_verified boolean NOT NULL DEFAULT FALSE;

CREATE TABLE mfa_enrollments (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  session_id uuid NOT NULL REFERENCES browser_sessions (id),
  secret jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);

CREATE INDEX mfa_challenges_user ON mfa_challenges (user_id);

CREATE TABLE mfa_recovery_codes (
  user_id uuid NOT NULL REFERENCES users (id),
  code_hash text NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);

CREATE INDEX browser_sessions_active ON browser_sessions (user_id, created_at DESC, id DESC)
WHERE
  revoked_at IS NULL;
