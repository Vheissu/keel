# Keel: Continuous Delivery and Release Orchestration

**Tagline:** Keel. Build anywhere. Deploy everywhere.  
**Status:** Proposed product and architecture blueprint.  
**Positioning:** Provider-agnostic continuous delivery and release management, a modern Octopus Deploy alternative. Keel does not offer native CI.

## Vision

Keel is a CD-first platform that consumes artifacts produced by GitHub Actions, Bitbucket Pipelines, Azure Pipelines, GitLab CI/CD, Jenkins, other CI providers or direct uploads. It manages immutable releases, approvals, environment promotion, deployment, verification, runbooks and recovery. Offer SaaS, self-hosted and hybrid deployment.

**Identity: Keel. Build anywhere. Deploy everywhere.** No CI migration required.

**Out of scope:** Native builds, tests, general-purpose CI runners, build matrices, CI caching, compiler toolchains, source checkout/build pipelines and hosted build-minute billing. Deployment execution and runbooks remain in scope.

## Feature specification

### Identity and organisations

Organisations, workspaces, projects, applications, teams, invitations, memberships, templates, tags, quotas, archiving, RBAC, custom roles, service accounts, scoped API tokens, SAML/OIDC SSO, MFA/passkeys, SCIM, session policies and audit logs.

### Git integrations

GitHub, GitLab, Bitbucket, Azure Repos, generic Git. Verified webhooks, replay protection, deduplication, retries, push/PR/tag/manual/scheduled/API triggers, commit status reporting, branch/path filters, monorepo change detection and fork PR trust boundaries.

### External CI providers and universal deployment control plane

Keel supports **CI-integrated CD**, **artifact-first CD** (direct upload, CLI, registry) and **externally executed CD** when a provider offers a supported deployment adapter. Keel never executes native CI builds. Customers retain their existing CI tools.

**First-class provider integrations:** GitHub Actions, Bitbucket Pipelines, Azure Pipelines (Azure DevOps), GitLab CI/CD and Jenkins. Design an extensible provider adapter SDK for additional systems. Git repository integrations are distinct from CI provider integrations: connecting GitHub source control does not automatically imply control over GitHub Actions.

**Provider operations:** connect and authenticate with least-privilege OAuth/apps, PATs or service principals as supported; discover repositories, pipelines and runs; receive verified provider webhooks or poll with backoff; retrieve run status, commit SHA, branch, tag, timestamps, logs and artifact metadata where APIs permit; trigger or cancel pipelines where supported and authorised; correlate source commits, external run IDs and Keel releases. Expose capability discovery and clear unsupported-operation errors rather than assuming uniform provider APIs.

**Artifact ingestion:** import external build outputs through provider APIs, signed upload URLs, registry references or a Keel publishing step/action. Verify hashes, record original provider/run/commit and provenance, store immutable artifact copies or verified digest-pinned registry references with retention guarantees. Never rely on short-lived CI artifact URLs for future rollback. Support webhook replay protection, idempotency, rate limits, API pagination, retries, and token expiry/rotation.

**Universal release workflow:** external CI succeeds -> Keel ingests/validates artifacts -> creates an immutable release manifest -> applies environment policies -> deploys using Keel-controlled agents or a supported provider deployment adapter -> verifies health -> records audit trail -> promotes or rolls back to an eligible previously retained release. Direct artifact uploads use the same release and deployment services.

**Centralised visibility:** a cross-provider dashboard with normalised build/run status, artifact provenance, deployment histories, currently deployed version by environment and tenant, approvals, failures and recovery candidates. Show source-provider links and original status without fabricating provider capabilities or hiding unavailable data.

**Rollback semantics:** when Keel owns the deployment, redeploy a previous immutable release and perform target-specific verification or traffic switching. Where an external provider owns deployment, allow provider-specific rollback/redeploy only if its APIs and configured workflows support it. Surface preflight checks, deployment locks, compatibility, data migration warnings and approval requirements. Rollback of application code cannot promise reversal of database changes or irreversible side effects. Track partial rollback and coordinated multi-service recovery separately.

**Proposed adapter contract (illustrative):**

```typescript
interface CIProviderAdapter {
  capabilities(): ProviderCapabilities;
  listPipelines(connection: ProviderConnection): Promise<ExternalPipeline[]>;
  getRun(connection: ProviderConnection, runId: string): Promise<ExternalRun>;
  listArtifacts(connection: ProviderConnection, runId: string): Promise<ExternalArtifact[]>;
  triggerRun?(connection: ProviderConnection, input: TriggerInput): Promise<ExternalRun>;
  cancelRun?(connection: ProviderConnection, runId: string): Promise<void>;
}
```

Model `ProviderConnection`, `ExternalPipeline`, `ExternalRun`, `ExternalArtifact`, `ArtifactImport`, `ProviderWebhookDelivery`, `DeploymentOwnership` and `RollbackCapability` in the domain. Keep provider-specific IDs and raw event payloads alongside normalised records; encrypt credentials and isolate organisation scopes.

**Acceptance criteria:** GitHub Actions and Bitbucket Pipelines can each produce an artifact Keel imports and deploys without using Keel CI; Azure Pipelines, GitLab CI/CD and Jenkins have equivalent documented integration contracts; a retained release remains redeployable after its source CI artifact expires; an operator can see deployment history and roll back a Keel-managed deployment regardless of originating CI provider; unsupported provider operations are clearly disabled; webhook retries cannot duplicate releases or deployments.

### Deployment process authoring

Versioned deployment YAML/JSON, visual process editor, canonical representation, validation, reusable deployment templates, target selection, conditional and parallel deployment steps, typed parameters, environment overrides, retries, timeouts, manual gates, dry-run planning and deployment-specific logs. Processes consume existing immutable artifacts; they do not build or test source code.

### Deployment execution agents

Private/managed outbound-only agents for SSH, Windows/IIS, Docker, Kubernetes and cloud deployment operations. Agent registration, mTLS, heartbeat, capability matching, revocation, draining, fenced leases, isolation, redacted logs and safe retry/reconciliation. These are **deployment agents**, not general-purpose CI runners.

### Artifacts

Content-addressed immutable S3-compatible blobs; SHA-256 checksums; ZIP/TAR, OCI, Helm, NuGet, npm, Maven and Python package integrations; signed downloads; resumable transfers; metadata; retention; quotas; replication; provenance; SBOM; signing; vulnerability scanning and safe garbage collection.

### Releases

Immutable manifests capturing commit, artifact digests, workflow/process revision, configuration references and provenance. Semantic/custom versioning, channels, release notes, comparisons, promotion without rebuilding, scheduling, approval gates, blackout windows, retention, previous-version redeployment and coordinated multi-application releases.

### Environments and deployment

Custom environments, lifecycle ordering, variables, secret references, credentials, policies, locks and windows. Targets: Linux/SSH, Windows/IIS, Docker, Kubernetes, AWS ECS, Azure App Service, serverless and generic API. Private outbound-only deployment agents. Strategies: recreate, rolling, blue/green, canary, progressive, multi-region and tenant rings. Pre/post hooks, migrations, smoke tests, health checks, traffic switching where supported, pause/resume, manual intervention, rollback eligibility and deployment concurrency. Maintain target/strategy compatibility rules.

### Tenant deployments

Customer tenants, groups/tags, tenant-specific target mappings, secrets and variables, cohort rollouts, throttling, selective deployment, per-tenant history and partial-failure isolation.

### Runbooks

Versioned independent operational workflows for backups, restarts, maintenance, certificate rotation and database operations; manual/scheduled/API triggers, typed inputs, approvals, scoped permissions, logs, retries, notifications and retention.

### Governance and security

Granular RBAC, SSO, MFA, separation of duties, multi-person approvals, deployment freezes, policy-as-code, change-ticket integration, tamper-evident audit exports, encryption, external vaults, short-lived cloud OIDC credentials, isolated deployment execution, egress restrictions, signed artifacts, provenance, supply-chain policy, retention/residency controls and security reviews. Compliance support does not imply certification.

### Observability and integrations

Unified commit-to-production timeline; live/searchable logs; external CI run links and status; deployment queue time; agent utilisation; release comparisons; deployment health; DORA-style metrics; OpenTelemetry; Prometheus-compatible metrics; Slack, Teams, email, webhooks and incident-management notifications.

### Developer experience, AI and billing

REST/OpenAPI, TypeScript SDK, CLI, signed webhooks, extension SDK, deployment template registry, target adapter SDK, templates. Optional AI workflow drafting, failure explanation, fix suggestions and release summaries with human approval and data controls. SaaS subscriptions, self-hosted licensing, usage metering, deployment concurrency, storage, quotas, invoices and budget alerts; pricing to be validated.

## Architecture

| Component | Choice |
|---|---|
| Frontend | Aurelia 2, TypeScript, Vite, Tailwind |
| API | Node.js, TypeScript, Fastify |
| Database | PostgreSQL |
| Durable orchestration | Temporal |
| Scheduler | Capability-aware dedicated service |
| Runner and deployment agents | Go |
| Artifact/log storage | S3-compatible object storage |
| Cache/rate limiting | Redis |
| Telemetry | OpenTelemetry and metrics/log backends |
| Packaging | Docker Compose, Kubernetes, Helm |
| Initial control-plane hosting | Railway if operationally suitable |

Begin with a modular monolith for control-plane domain services, and independent scheduler, workflow workers, log ingestion and deployment-agent processes. Never run deployment scripts in the API service.

```text
Git providers -> Verified webhooks -> API / Control plane
                                         |
                                Auth / Policy / Domain
                                         |
                                PostgreSQL + Outbox
                                         |
                                  Temporal workers
                                         |
                                Capability scheduler
                                         |
                           +-------------+-------------+
                           |                           |
                    Managed agents              Private agents
                    (ephemeral)                 (outbound mTLS)
                           +-------------+-------------+
                                         |
                              Artifacts / Logs / Tests
                                         |
                              Releases / Deployments
                                         |
                              Targets / Environments
```

### Monorepo

```text
keel/
  apps/{web,api,scheduler,workflow-worker,log-ingester,webhook-dispatcher}/
  agents/deployment-agent/
  packages/{domain,database,auth,deployment-schema,process-compiler,policy-engine,integrations,sdk,ui}/
  infrastructure/{docker,kubernetes,terraform}/
  docs/
  examples/
  tests/{unit,integration,e2e,security,resilience}/
```

### Domain entities

Organisation, Workspace, User, Team, Membership, Role, ServiceAccount, Project, Application, Repository, Integration, WorkflowDefinition, WorkflowRevision, PipelineRun, JobRun, StepRun, RunnerPool, Runner, RunnerLease, ExecutionAttempt, Artifact, ArtifactBlob, ArtifactVersion, Provenance, Release, ReleaseManifest, Environment, Deployment, DeploymentTarget, Tenant, TenantGroup, ApprovalPolicy, ApprovalRequest, AuditEvent, SecretReference, Runbook, RunbookRun, Schedule, NotificationRule, Subscription and UsageRecord.

All organisation-owned records require organisation scoping and database constraints preventing cross-tenant references. Job attempts are separate from logical jobs; state transitions are recorded in append-only events with current-state projections.

## Proposed deployment process DSL

The YAML below describes deploying an **already built** artifact, not a CI pipeline. This is an illustrative schema, not an implemented interface.

```yaml
apiVersion: keel.dev/v1alpha1
kind: DeploymentProcess
metadata:
  name: web-app
spec:
  artifact:
    source: release
    name: application
  environments:
    staging:
      strategy: rolling
      targetSelector: { labels: { app: web, tier: staging } }
      verify: { http: { path: /health } }
    production:
      strategy: blue-green
      requiresApproval: true
      targetSelector: { labels: { app: web, tier: production } }
      verify: { http: { path: /health } }
```

Example of a publishing step inside **GitHub Actions**, not Keel CI:

```yaml
- name: Publish artifact to Keel
  run: keel artifact publish ./dist/app.tar.gz --project web --name application
  env:
    KEEL_TOKEN: ${{ secrets.KEEL_PUBLISH_TOKEN }}
```

Prefer short-lived federated identity where supported.

## Deployment agent and workflow reliability

Runner lifecycle: register, authenticate, advertise capabilities, heartbeat, acquire fenced lease, receive short-lived scoped credentials, execute isolated job, stream logs, upload artifacts, submit result, clean up, drain/revoke. Scheduler enforces capabilities, resource quotas, fairness, priorities and concurrency. Temporal handles durable workflow coordination and approvals, not execution of untrusted scripts. Use a PostgreSQL transactional outbox for events. Assume at-least-once delivery, require idempotency and reconciliation for external effects. Stale agents cannot complete cancelled jobs.

Threat model: compromised provider credentials, deployment agent compromise, secrets leakage, artifact tampering, webhook replay, artifact substitution, cross-organisation access and supply-chain attacks. Keep deployment agents separate from CI provider infrastructure and scope their access by organisation, target and environment.

## Release invariants

A release is immutable; a deployment executes that release against an environment and targets. Promotion never rebuilds. Each deployment records actor, approval, policy, configuration revision, target and result. Rollback is an auditable redeployment of a previous release where supported; database migrations and external side effects may be irreversible. Canary/blue-green need target-specific traffic control and verification.

## UI

Navigation: Overview, Projects, Pipelines, Runs, Artifacts, Releases, Deployments, Environments, Targets, Tenants, Runbooks, Runners, Insights, Integrations and Settings.

Key views: organisation dashboard, project summary, YAML/visual deployment process editor, external CI activity, artifact browser, release comparison, environment version matrix, deployment progress/verification, approval inbox, deployment agent fleet, tenant deployment matrix, runbook catalogue, audit/permissions and usage/billing. Require accessibility, keyboard navigation, responsive layouts, useful empty states and timezone-aware timestamps.

## API and CLI

Versioned REST resources, OpenAPI, typed SDK, cursor pagination, scoped tokens, idempotency keys, stable errors, rate limiting, correlation IDs and signed outbound webhooks.

```bash
keel init
keel login
keel validate
keel artifact publish ./app.tar.gz --project web
keel release create
keel deploy production
keel rollback production
keel status
```

CLI supports JSON output, meaningful exit codes and confirmation for protected operations.

## Hosting

**SaaS:** Hosted control plane, database, Temporal, storage and optional managed deployment agents. **Self-hosted:** Docker Compose for evaluation and Helm/Kubernetes for production, with documented dependencies, backup/restore, TLS, upgrades and high availability. **Hybrid:** Hosted control plane with private outbound-only customer deployment agents. Never execute customer deployment scripts on control-plane compute.

## Quality and acceptance criteria

Test domain invariants, DSL parsing, policy, database and workflow integration, agent contracts, end-to-end deployments, security isolation, concurrency, fault injection, load, accessibility, upgrades and disaster recovery.

Acceptance scenarios:

1. Git push creates a validated run and updates commit status.
2. Failed tests block release promotion.
3. Staging and production use the identical artifact digest.
4. Protected deployment approvals cannot be bypassed via API, YAML or CLI.
5. Untrusted provider events cannot access production secrets or privileged deployment agents.
6. Runner crashes recover without false success or duplicate uncontrolled effects.
7. Duplicate webhooks are safely deduplicated.
8. Cancelled jobs reject late results.
9. Deployment failures show target-specific diagnostics and recovery actions.
10. Private agents deploy without inbound firewall access.
11. Organisation isolation holds across API, logs, artifacts and secrets.
12. Previous releases can be redeployed where compatible.
13. Audit exports identify approvals and changes.
14. Self-hosted backup/restore yields usable state.
15. Upgrades preserve histories, releases and credential references.

## Build priorities (not deadlines)

**Foundation:** Organisations, GitHub Actions provider integration, generic webhook and direct artifact publishing, provider adapter contract, PostgreSQL, Temporal, immutable artifact storage, deployment agent protocol, basic SSH/Docker deployment, release manifests, audit and UI.

**First commercially useful version:** GitHub Actions and Bitbucket Pipelines artifact ingestion, staging/production environments, approvals, immutable promotion, health verification, rollback to retained artifacts, secrets, notifications, reliable agent execution and self-hosted agent connectivity.

**Broad platform:** Azure Pipelines, GitLab CI/CD and Jenkins integrations; Kubernetes, Windows/IIS and cloud target adapters; visual deployment editor; tenant deployments; runbooks; deployment analytics; SaaS and self-hosted packaging.

**Enterprise depth:** SAML/SCIM, advanced policy and separation of duties, provenance enforcement, multi-region delivery, high availability and disaster recovery, progressive rollout strategies, enterprise licensing and audit exports.

## Commercial strategy and risks

Differentiate through provider-neutral CD, release promotion, developer experience, tenant-aware deployments, reliable recovery and predictable pricing. Validate demand with teams using existing CI. Model agent operations, artifact storage, bandwidth, support and enterprise procurement; no hosted CI runner cost model.

Major risks: untrusted code execution, distributed job duplication, adapter maintenance, visual/YAML divergence, scope expansion, secrets exposure, compute costs, unsafe rollback, compliance burden and potential Keel name conflicts. Mitigate through isolation, durable state, versioned contracts, canonical IR, strict priorities, scoped credentials, quotas, explicit rollback limits, security assessment and trademark/domain clearance.

## Open decisions

Temporal Cloud vs self-hosted Temporal; native registry vs external registries; deployment agent sandbox technology; precise deployment DSL semantics; RLS strategy; audit/event retention; agent transport protocol; visual graph library; secrets provider; initial deployment adapters; licensing and pricing; regional data residency; product website/domain.

## Definition of product success

A team can connect its existing CI provider or publish an artifact directly, create an immutable release, promote it through staging and production with policy-based approval, inspect every deployment, deploy through a private agent and recover from supported failures without migrating its CI pipelines.
