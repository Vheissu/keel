ALTER TABLE runbook_plans
ADD COLUMN input_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_values) = 'object');

-- The existing immutable review trigger protects the accepted input values too.
