# Implementation status

The control-plane foundation, GitHub ingestion, Bitbucket publishing and Docker execution, agent recovery, promotion policy, rollback planning, scoped deployment secrets, self-hosted packaging, operational recovery, paginated resource navigation and durable webhook notifications are implemented. PLAN.md remains the product roadmap.

## Implemented

- npm workspace layout with Aurelia 2, TypeScript, Vite, Tailwind, Fastify, and PostgreSQL.
- Local workspace bootstrap with separate operator and approver tokens, hashed credentials, and fixed staging/production environments.
- Project creation, artifact upload/download, immutable releases with canonical process snapshots, and deployment requests.
- SHA-256 verification, atomic content-addressed local blob writes, database immutability triggers, and composite foreign keys across organisation/project references.
- Strict deployment process validation for release artifacts, environment selectors, recreate/rolling strategy declarations, and optional HTTP verification declarations. The Docker executor accepts recreate, a pinned image ID and an HTTP verification path; rolling remains a declaration only.
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

- Cursor pagination, full-collection search and scoped lookups for 15 resource collections, with matching database indexes and metadata-only projections for sensitive resources.
- Paged tables and form selectors, browser history and reload state, CLI list filters, and navigation through older verified rollback releases.

- Signed deployment webhooks with scoped event rules, encrypted destinations, durable delivery jobs, leased attempts, bounded retries and visible UI/CLI delivery history.
- A separate notification worker in local development and self-hosted Compose, with restore quarantine for unfinished deliveries.

## Next increment

Add hosted identity and workspace membership with managed token lifecycle. SSO, SSH, additional deployment strategies and automated rollback remain later work.

## Decisions and constraints

The control plane is a modular monolith. Domain policy, process validation, database setup, and provider types are separate packages. The API does not launch customer commands.

Artifact storage uses the local filesystem by default, or S3 through the same `ArtifactStore` interface. Organisation IDs and digests determine paths. Writes use a temporary file plus an atomic hard link; an existing digest is verified rather than overwritten. A database rollback can leave an unreferenced blob. No garbage collector runs yet, so a failed transaction cannot accidentally delete a retained release’s bytes. S3 writes use `If-None-Match: *`, and every read verifies SHA-256. Conditional writes prevent this application from replacing existing objects; bucket administrators can still delete or alter them. No garbage collector, object-lock policy or retention expiry is implemented. Copy existing local blobs before changing storage drivers; see [storage setup](storage.md).

SQL queries scope every organisation-owned API read, and composite foreign keys prevent cross-organisation and cross-project references. PostgreSQL RLS is not enabled. The development database role can administer its evaluation database. The self-hosted package uses separate migration and runtime roles; its runtime role has no DDL or Temporal database access. Immutable triggers prevent ordinary updates and deletes, not changes by a database administrator.

The local bootstrap is not a hosted identity system. There is no invitation flow, token-management UI, token expiry, SSO, session cookie, or custom-role editor. Tokens are permission-scoped, but not yet project- or environment-scoped. Keep the development services bound to loopback. The browser does not persist credentials.

Deployment outbox entries are delivered by the Temporal worker. Artifact ingestion retains its separate PostgreSQL-backed worker. Redis, runbooks, tenants, scheduled releases, and high-availability packaging remain unimplemented. See [Docker agent setup and limits](deployment-agents.md), including the 25 MiB archive cap and same-host certificate recovery and the absence of force-unlock or host reassignment. Production defaults to requiring verified staging of the exact release before admission. Approvers can edit prerequisites; accepted requests retain their admission snapshot. See [promotion and rollback](promotion-and-rollback.md) and [deployment secrets](deployment-secrets.md) for policy, key management and recovery boundaries.

The dashboard shows the newest request per environment, including its pending/cancelled state. It does not claim that this is the currently deployed version. The overview and legacy snapshot endpoints retain a 200-record window. Resource screens and selectors use cursor pagination over the full collection. The overview resolves the newest request for each displayed project and environment independently of that window. Search and exact counts run in PostgreSQL; this stage does not add a search index or distributed rate limiting.

## Ingestion boundaries

GitHub connections use a repository-scoped token with Actions read permission. Bitbucket connections use repository access tokens with Repository read and Pipelines read permissions, plus a separate secret for publishing submissions. There is no GitHub App installation, OAuth flow or automatic token renewal. The encryption key stays in server configuration and must be backed up separately from PostgreSQL; automatic master-key rotation is not implemented. Provider tokens, webhook secrets and publishing secrets can be rotated through the UI, API or CLI.

Imports are limited to 25 MiB, current successful run attempts, one configured artifact name, and 1,000 artifacts/workflows per discovery operation. The import worker retains the original ZIP unchanged. For Docker deployment, the release selects one archive entry for a bounded in-memory read by the agent. Keel requires GitHub's SHA-256 metadata rather than accepting unverified legacy artifacts. Webhooks queue imports only. Operators create releases from retained artifacts through the existing release flow.

Bitbucket does not expose native artifact discovery or download through this adapter. A dependency-free publishing script submits up to 25 MiB while its pipeline step is running. Keel verifies the run, step, repository, exact branch, selector and commit, polls for whole-pipeline success, then publishes immutable artifact metadata. Submitted blobs have no release-visible artifact record until verification succeeds. The checksum is publisher-supplied, not a provider attestation; protect the connection-scoped publishing secret and pipeline code. Identical submissions are deduplicated; replacements require a new pipeline UUID. Polling waits at most 24 hours without consuming transient-failure retries. See [Bitbucket setup](bitbucket-pipelines.md).

Tests use GitHub and Bitbucket HTTP fixtures, real PostgreSQL and a real local S3-compatible RustFS service. No live provider repository is connected by the test suite. The object store in development Compose is for local evaluation. The self-hosted package and its backup procedure use local artifact volumes; see [self-hosting](self-hosting.md) and [recovery](recovery.md).

## Design

The original visual reference is [overview-reference.png](design/overview-reference.png). The revised [nautical reference](design/overview-nautical.png) is the implementation reference: navy `#102d40`, sea teal `#226d75`, off-white `#f8faf9`, and brass for attention states. The reference was produced with the built-in image generator, then adjusted in code for contrast and responsive layout.

The design prompt requested a restrained continuous-delivery dashboard, a navy sidebar, sea-teal actions, an off-white canvas, and a small line-drawn boat in the empty state. It preserved the overview metrics and environment table and excluded decorative ropes, anchors, or invented deployment activity. The boat loader moves slightly along a short waterline; reduced-motion mode disables both animations.

Technical references used during implementation: [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) and [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).
