ALTER TABLE deployment_events
ADD CONSTRAINT deployment_events_org_id UNIQUE (organisation_id, id);

CREATE TABLE notification_endpoints (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL,
  origin text NOT NULL,
  credentials jsonb NOT NULL,
  project_id uuid,
  environment_id uuid,
  statuses TEXT[] NOT NULL,
  enabled boolean NOT NULL DEFAULT TRUE,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  FOREIGN KEY (organisation_id, environment_id) REFERENCES environments (organisation_id, id)
);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  event_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'sending',
      'retrying',
      'delivered',
      'failed',
      'cancelled'
    )
  ),
  attempt_count integer NOT NULL DEFAULT 0,
  cycle_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_code text,
  last_http_status integer,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (endpoint_id, event_id),
  FOREIGN KEY (organisation_id, event_id) REFERENCES deployment_events (organisation_id, id),
  FOREIGN KEY (organisation_id, endpoint_id) REFERENCES notification_endpoints (organisation_id, id),
  FOREIGN KEY (organisation_id, deployment_id) REFERENCES deployments (organisation_id, id)
);

CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt integer NOT NULL,
  code text NOT NULL DEFAULT 'IN_FLIGHT',
  http_status integer,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt),
  FOREIGN KEY (organisation_id, delivery_id) REFERENCES notification_deliveries (organisation_id, id)
);

CREATE INDEX notification_endpoints_org_time ON notification_endpoints (organisation_id, created_at DESC, id DESC);

CREATE INDEX notification_deliveries_org_time ON notification_deliveries (organisation_id, created_at DESC, id DESC);

CREATE INDEX notification_attempts_org_time ON notification_attempts (organisation_id, created_at DESC, id DESC);

CREATE INDEX notification_deliveries_due ON notification_deliveries (next_attempt_at, lease_expires_at)
WHERE
  status IN ('pending', 'retrying', 'sending');
