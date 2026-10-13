-- Existing destinations keep receiving deployment events only; runbook results are opt-in so a
-- receiver never sees an event type it was not written to handle.
ALTER TABLE notification_endpoints
ADD COLUMN work_kinds TEXT[] NOT NULL DEFAULT ARRAY['deployment']::TEXT[] CHECK (
  cardinality(work_kinds) > 0
  AND work_kinds <@ ARRAY['deployment', 'runbook']::TEXT[]
);
