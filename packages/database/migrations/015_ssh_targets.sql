ALTER TABLE deployment_targets
DROP CONSTRAINT deployment_targets_capability_check;

ALTER TABLE deployment_targets
ADD CONSTRAINT deployment_targets_capability_check CHECK (
  capability IN ('docker-recreate-v1', 'ssh-docker-recreate-v1')
);
