ALTER TABLE deployment_targets
DROP CONSTRAINT deployment_targets_capability_check;

ALTER TABLE deployment_targets
ADD CONSTRAINT deployment_targets_capability_check CHECK (
  capability IN (
    'docker-recreate-v1',
    'ssh-docker-recreate-v1',
    'docker-blue-green-v1'
  )
);

ALTER TABLE deployment_attempts
DROP CONSTRAINT deployment_attempts_phase_check;

ALTER TABLE deployment_attempts
ADD CONSTRAINT deployment_attempts_phase_check CHECK (
  phase IN (
    'waiting',
    'downloading',
    'loading_image',
    'replacing_container',
    'starting_candidate',
    'verifying_http',
    'switching_traffic',
    'cleaning_up'
  )
);

ALTER TABLE deployment_attempts
ADD COLUMN recovery text CHECK (
  recovery IN ('previous_route_restored', 'no_previous_route')
);
