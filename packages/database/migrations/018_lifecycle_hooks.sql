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
    'pre_hook',
    'post_hook',
    'verifying_http',
    'switching_traffic',
    'cleaning_up'
  )
);
