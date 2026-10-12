CREATE INDEX projects_resource_page ON projects (organisation_id, created_at DESC, id DESC);

CREATE INDEX environments_resource_page ON environments (organisation_id, created_at DESC, id DESC);

CREATE INDEX artifacts_resource_page ON artifacts (organisation_id, created_at DESC, id DESC);

CREATE INDEX artifacts_project_page ON artifacts (
  organisation_id,
  project_id,
  created_at DESC,
  id DESC
);

CREATE INDEX releases_resource_page ON releases (organisation_id, created_at DESC, id DESC);

CREATE INDEX releases_project_page ON releases (
  organisation_id,
  project_id,
  created_at DESC,
  id DESC
);

CREATE INDEX deployments_resource_page ON deployments (organisation_id, created_at DESC, id DESC);

CREATE INDEX deployments_project_environment_page ON deployments (
  organisation_id,
  project_id,
  environment_id,
  created_at DESC,
  id DESC
);

CREATE INDEX audit_resource_page ON audit_events (organisation_id, created_at DESC, id DESC);

CREATE INDEX agents_resource_page ON deployment_agents (organisation_id, created_at DESC, id DESC);

CREATE INDEX targets_resource_page ON deployment_targets (organisation_id, created_at DESC, id DESC);

CREATE INDEX attempts_resource_page ON deployment_attempts (organisation_id, created_at DESC, id DESC);

CREATE INDEX connections_resource_page ON provider_connections (organisation_id, created_at DESC, id DESC);

CREATE INDEX imports_resource_page ON artifact_imports (organisation_id, created_at DESC, id DESC);

CREATE INDEX secrets_scope_page ON deployment_secrets (
  organisation_id,
  project_id,
  environment_id,
  created_at DESC,
  id DESC
);
