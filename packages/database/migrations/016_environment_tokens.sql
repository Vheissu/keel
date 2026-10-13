ALTER TABLE api_tokens
ADD COLUMN environment_ids UUID[] CHECK (
  environment_ids IS NULL
  OR cardinality(environment_ids) BETWEEN 1 AND 100
);
