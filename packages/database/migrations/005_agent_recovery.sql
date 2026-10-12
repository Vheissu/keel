CREATE TABLE agent_certificates (
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  organisation_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organisation_id, agent_id) REFERENCES deployment_agents (organisation_id, id)
);

INSERT INTO
  agent_certificates (fingerprint, organisation_id, agent_id)
SELECT
  certificate_fingerprint,
  organisation_id,
  id
FROM
  deployment_agents;

ALTER TABLE deployment_attempts
ADD COLUMN phase text NOT NULL DEFAULT 'waiting' CHECK (
  phase IN (
    'waiting',
    'downloading',
    'loading_image',
    'replacing_container',
    'verifying_http',
    'cleaning_up'
  )
),
ADD COLUMN phase_updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER immutable_agent_certificates
BEFORE UPDATE OR DELETE ON agent_certificates FOR EACH ROW
EXECUTE FUNCTION reject_immutable_change ();
