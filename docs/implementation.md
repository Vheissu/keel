# Implementation status

The control-plane foundation, GitHub ingestion, Bitbucket publishing and local/SSH Docker execution, agent recovery, promotion policy, rollback planning, scoped deployment secrets, self-hosted packaging, operational recovery, paginated resource navigation, durable webhook notifications, invitation-only accounts, workspace membership and managed token lifecycle, authenticator MFA and session management, OIDC SSO, workspace authentication policies and passkey sign-in are implemented. PLAN.md remains the product roadmap.

## Implemented

- npm workspace layout with Aurelia 2, TypeScript, Vite, Tailwind, Fastify, and PostgreSQL.
- Local workspace bootstrap with separate operator and approver tokens, hashed credentials, and fixed staging/production environments.
- Project creation, artifact upload/download, immutable releases with canonical process snapshots, and deployment requests.
- SHA-256 verification, atomic content-addressed local blob writes, database immutability triggers, and composite foreign keys across organisation/project references.
- Strict deployment process validation for release artifacts, environment selectors, recreate/blue-green/rolling strategy declarations, and optional HTTP verification declarations. Execution requires a pinned image ID and an HTTP verification path; rolling remains a declaration only.
- Environment approval enforcement, separation of duties, environment request locks, cancellation/rejection, append-only audit/deployment events, and transactional outbox writes.
- Persistent request idempotency, scoped tokens, request validation, bounded uploads, stable errors, and process-local rate limiting.
- GitHub Actions adapter with workflow discovery, authoritative run checks, paginated artifact discovery, signed download handling and SHA-256 verification. Bitbucket uses a separate publishing flow; other providers remain explicitly unavailable.
- AES-256-GCM connection credentials, credential rotation, verified/deduplicated webhooks, durable import jobs with leased workers and persisted retries.
- S3-compatible storage with conditional writes and digest verification, plus a local-to-S3 copy command.
- Bitbucket Cloud publishing with connection-scoped credentials, running-step validation, private candidate blobs and polling until the complete pipeline succeeds.
- Integration management, manual GitHub imports, Bitbucket publishing and retry controls in the UI and CLI.
- CLI publishing, release creation, process validation, and status output.
- Responsive UI, keyboard-accessible dialogs, reduced-motion boat loaders, and empty states backed by actual data.
- Temporal deployment workflows and transactional outbox delivery, with stable workflow IDs.
- A separate mutual-TLS gateway and outbound Go agent with scoped downloads, heartbeats, monotonic target fences, draining and revocation.
- SSH Docker targets with strict host-key verification, local connection allowlists, a remote helper, durable remote fences and session locks.
- Local Docker blue/green execution with two container slots, an agent-managed HTTP proxy, durable route switching, explicit target compatibility and fenced route recovery.
- Controlled Docker recreate execution of a retained image archive, HTTP verification, cancellation cleanup and expiry reconciliation.
- Target registration, agent state and verified-release projections in the UI.
- Explicit Docker archive entry selection inside retained GitHub ZIPs, with bounded reads and archive validation.
- Same-host agent certificate replacement, permanently retired fingerprints, cleanup before resume and an audit trail.
- Lease-scoped deployment progress, timestamps and target-specific failure/recovery guidance.
- Approver-managed promotion prerequisites with exact-release verification evidence, cycle prevention and immutable admission snapshots.
- Retained-release rollback plans with target/fence pinning, expiry, byte verification, data-boundary acknowledgement and ordinary approvals.
- Promotion and rollback review in the UI and CLI.
- Encrypted, versioned deployment secrets scoped to a project and environment, with separate management permission, admission-time pinning and revocation.
- Lease-scoped secret delivery to capable agents through mutual TLS and Docker stdin, with metadata-only UI/CLI responses and fixed-code execution reporting.

- Single-host Compose packaging with compiled HTTPS UI/API, persistent PostgreSQL and Temporal, separate migration/runtime roles, generated credentials and service health checks.
- Encrypted cold backups covering database, retained artifacts, configuration and keys; authenticated fresh-volume restore with retained-data verification and revoked agents.

- Cursor pagination, full-collection search and scoped lookups for 18 resource collections, with matching database indexes and metadata-only projections for sensitive resources.
- Paged tables and form selectors, browser history and reload state, CLI list filters, and navigation through older verified rollback releases.

- Signed deployment webhooks with scoped event rules, encrypted destinations, durable delivery jobs, leased attempts, bounded retries and visible UI/CLI delivery history.
- A separate notification worker in local development and self-hosted Compose, with restore quarantine for unfinished deliveries.

- Invitation-only email/password accounts, expiring browser sessions, workspace roles, member removal and last-owner protection.
- Managed API tokens with explicit permissions, expiry, one-time reveal, atomic rotation and revocation; current membership limits every request.
- Server provisioning and password recovery commands, workspace switching, access-management screens and restore quarantine for identity credentials.

- Authenticator MFA with encrypted secrets, replay-protected codes, one-use recovery codes, bounded sign-in challenges and operator recovery.
- Account session listing and revocation, idle expiry, session limits and MFA-aware backup verification and restore quarantine.

- Operator-configured OIDC providers, explicit account linking, signed authorization-code sign-in and workspace-bound SSO sessions.
- Owner-managed SSO/MFA requirements, browser-session age and API-token policies, with transactional enforcement and operator recovery.
- Passkey enrollment, discoverable sign-in and removal with WebAuthn verification, single-use challenges and existing MFA/policy enforcement.

- Owner-managed custom roles with revision checks, invitation/member assignment and immediate effective-permission changes.
- Project- and environment-scoped managed tokens with intersected access, filtered reads and counts, guarded delivery operations, scope-preserving rotation and matching access-management controls.
- Scoped promotion checks retain policy enforcement while withholding prerequisite evidence outside the token’s environment selection.

- Pre- and post-deploy container hooks with required timeouts, resource limits, explicit secret selection and operator-controlled networking.
- Capability-gated hook assignments, durable lifecycle journals, cleanup-only crash recovery and phase-specific failure guidance for local/SSH recreate and local blue/green.

- Independent runbook definitions with immutable versions, fixed bounded commands and expiring reviews of exact targets, policy and secret versions.
- Separate approvals, shared environment locks, capability-gated agent execution, task-only cleanup and UI/CLI history without application promotion evidence.
- Typed runbook inputs with explicit bounds and defaults, immutable reviewed values, matching approval/history views and literal environment delivery to capable local and SSH agents.

## Next increment

Add runbook result notifications through the existing signed webhook delivery service. Scheduling, multi-step runbooks, SAML, SCIM, non-container SSH deployments, multi-host strategies and automated rollback remain later work.

## Decisions and constraints

The control plane is a modular monolith. Domain policy, process validation, database setup, and provider types are separate packages. The API does not launch customer commands.

Artifact storage uses the local filesystem by default, or S3 through the same `ArtifactStore` interface. Organisation IDs and digests determine paths. Writes use a temporary file plus an atomic hard link; an existing digest is verified rather than overwritten. A database rollback can leave an unreferenced blob. No garbage collector runs yet, so a failed transaction cannot accidentally delete a retained release’s bytes. S3 writes use `If-None-Match: *`, and every read verifies SHA-256. Conditional writes prevent this application from replacing existing objects; bucket administrators can still delete or alter them. No garbage collector, object-lock policy or retention expiry is implemented. Copy existing local blobs before changing storage drivers; see [storage setup](storage.md).

SQL queries scope every organisation-owned API read, and composite foreign keys prevent cross-organisation and cross-project references. PostgreSQL RLS is not enabled. The development database role can administer its evaluation database. The self-hosted package uses separate migration and runtime roles; its runtime role has no DDL or Temporal database access. Immutable triggers prevent ordinary updates and deletes, not changes by a database administrator.

The optional hosted identity mode uses invitation-only accounts and HttpOnly session cookies. Enabling it rejects legacy bootstrap tokens; the local bootstrap remains available when it is disabled. Managed tokens have explicit permissions and optional project and environment restrictions. Both selections apply when present; shared artifacts and release manifests remain readable, while publishing requires access to all environments. OIDC SSO providers are provisioned by a server operator; account linking is explicit and membership remains invitation-only. Passkeys provide device-verified sign-in for existing accounts, with enrollment and removal in Account security. Enrolled MFA and workspace authentication policies still apply. Owners can define custom delivery roles. SAML, SCIM and email delivery remain unimplemented. See [account setup and recovery](identity.md).

Deployment and runbook outbox entries are delivered by the Temporal worker. Artifact ingestion retains its separate PostgreSQL-backed worker. Redis, tenants, scheduled releases, and high-availability packaging remain unimplemented. See [Docker agent setup and limits](deployment-agents.md), including the 25 MiB archive cap and same-host certificate recovery and the absence of force-unlock or host reassignment. Production defaults to requiring verified staging of the exact release before admission. Approvers can edit prerequisites; accepted requests retain their admission snapshot. See [promotion and rollback](promotion-and-rollback.md), [deployment secrets](deployment-secrets.md) and [lifecycle hooks](lifecycle-hooks.md) and [runbooks](runbooks.md) for policy, key management and recovery boundaries.

The dashboard shows the newest request per environment, including its pending/cancelled state. It does not claim that this is the currently deployed version. The overview and legacy snapshot endpoints retain a 200-record window. Resource screens and selectors use cursor pagination over the full collection. The overview resolves the newest request for each displayed project and environment independently of that window. Search and exact counts run in PostgreSQL; there is no search index or distributed general-purpose rate limiter. Hosted login attempts have a shared per-account budget in PostgreSQL.

## Ingestion boundaries

GitHub connections use a repository-scoped token with Actions read permission. Bitbucket connections use repository access tokens with Repository read and Pipelines read permissions, plus a separate secret for publishing submissions. There is no GitHub App installation, OAuth flow or automatic token renewal. The encryption key stays in server configuration and must be backed up separately from PostgreSQL; automatic master-key rotation is not implemented. Provider tokens, webhook secrets and publishing secrets can be rotated through the UI, API or CLI.

Imports are limited to 25 MiB, current successful run attempts, one configured artifact name, and 1,000 artifacts/workflows per discovery operation. The import worker retains the original ZIP unchanged. For Docker deployment, the release selects one archive entry for a bounded in-memory read by the agent. Keel requires GitHub's SHA-256 metadata rather than accepting unverified legacy artifacts. Webhooks queue imports only. Operators create releases from retained artifacts through the existing release flow.

Bitbucket does not expose native artifact discovery or download through this adapter. A dependency-free publishing script submits up to 25 MiB while its pipeline step is running. Keel verifies the run, step, repository, exact branch, selector and commit, polls for whole-pipeline success, then publishes immutable artifact metadata. Submitted blobs have no release-visible artifact record until verification succeeds. The checksum is publisher-supplied, not a provider attestation; protect the connection-scoped publishing secret and pipeline code. Identical submissions are deduplicated; replacements require a new pipeline UUID. Polling waits at most 24 hours without consuming transient-failure retries. See [Bitbucket setup](bitbucket-pipelines.md).

Tests use GitHub and Bitbucket HTTP fixtures, real PostgreSQL and a real local S3-compatible RustFS service. No live provider repository is connected by the test suite. The object store in development Compose is for local evaluation. The self-hosted package and its backup procedure use local artifact volumes; see [self-hosting](self-hosting.md) and [recovery](recovery.md).

## Design

The original visual reference is [overview-reference.png](design/overview-reference.png). The revised [nautical reference](design/overview-nautical.png) is the implementation reference: navy `#102d40`, sea teal `#226d75`, off-white `#f8faf9`, and brass for attention states. The reference was produced with the built-in image generator, then adjusted in code for contrast and responsive layout.

The design prompt requested a restrained continuous-delivery dashboard, a navy sidebar, sea-teal actions, an off-white canvas, and a small line-drawn boat in the empty state. It preserved the overview metrics and environment table and excluded decorative ropes, anchors, or invented deployment activity. The boat loader moves slightly along a short waterline; reduced-motion mode disables both animations.

Technical references used during implementation: [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) and [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).
