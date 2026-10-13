CREATE TABLE passkeys (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  name text NOT NULL,
  public_key bytea NOT NULL,
  counter bigint NOT NULL CHECK (counter >= 0),
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE passkey_attempts (
  token_hash text PRIMARY KEY,
  challenge_hash text NOT NULL,
  user_id uuid REFERENCES users (id),
  session_id uuid REFERENCES browser_sessions (id),
  name text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  CHECK (
    (
      user_id IS NULL
      AND session_id IS NULL
      AND name IS NULL
    )
    OR (
      user_id IS NOT NULL
      AND session_id IS NOT NULL
      AND name IS NOT NULL
    )
  )
);

CREATE INDEX passkey_attempts_expiry ON passkey_attempts (expires_at);

CREATE INDEX passkey_attempts_user ON passkey_attempts (user_id);

ALTER TABLE mfa_challenges
ADD COLUMN passkey_id text REFERENCES passkeys (id) ON DELETE CASCADE;
