# Implementation status

The control-plane foundation and first GitHub ingestion stage are implemented. PLAN.md remains the product roadmap.

## Implemented

- npm workspace layout with Aurelia 2, TypeScript, Vite, Tailwind, Fastify, and PostgreSQL.
- Local workspace bootstrap with separate operator and approver tokens, hashed credentials, and fixed staging/production environments.
- Project creation, artifact upload/download, immutable releases with canonical process snapshots, and deployment requests.
- SHA-256 verification, atomic content-addressed local blob writes, database immutability triggers, and composite foreign keys across organisation/project references.
- Strict deployment process validation for release artifacts, environment selectors, recreate/rolling strategy declarations, and optional HTTP verification declarations. These describe intent; no target executor exists yet.
- Environment approval enforcement, separation of duties, environment request locks, cancellation/rejection, append-only audit/deployment events, and transactional outbox writes.
- Persistent request idempotency, scoped tokens, request validation, bounded uploads, stable errors, and process-local rate limiting.
- GitHub Actions adapter with workflow discovery, authoritative run checks, paginated artifact discovery, signed download handling and SHA-256 verification. Other providers remain explicitly unavailable.
- AES-256-GCM connection credentials, credential rotation, verified/deduplicated webhooks, durable import jobs with leased workers and persisted retries.
- S3-compatible storage with conditional writes and digest verification, plus a local-to-S3 copy command.
- Integration management, manual imports and retry controls in the UI and CLI.
- CLI publishing, release creation, process validation, and status output.
- Responsive UI, keyboard-accessible dialogs, reduced-motion boat loaders, and empty states backed by actual data.

## Next increment

Add Bitbucket Pipelines ingestion through the provider adapter contract, keeping the same retained-artifact and release services. Extend provider contracts for Azure Pipelines, GitLab CI/CD and Jenkins as those implementations are built.

Then connect the deployment outbox to Temporal and implement a fenced, outbound-only agent protocol. A queued deployment must never be treated as an executed deployment. The worker needs idempotent dispatch, cancellation reconciliation, heartbeats, lease expiry, log redaction, target validation, and verification results before a successful state can exist. Deploy one retained artifact to a controlled Docker target before adding SSH or additional strategies.

## Decisions and constraints

The control plane is a modular monolith. Domain policy, process validation, database setup, and provider types are separate packages. The API does not launch customer commands.

Artifact storage uses the local filesystem by default, or S3 through the same `ArtifactStore` interface. Organisation IDs and digests determine paths. Writes use a temporary file plus an atomic hard link; an existing digest is verified rather than overwritten. A database rollback can leave an unreferenced blob. No garbage collector runs yet, so a failed transaction cannot accidentally delete a retained release’s bytes. S3 writes use `If-None-Match: *`, and every read verifies SHA-256. Conditional writes prevent this application from replacing existing objects; bucket administrators can still delete or alter them. No garbage collector, object-lock policy or retention expiry is implemented. Copy existing local blobs before changing storage drivers; see [storage setup](storage.md).

SQL queries scope every organisation-owned API read, and composite foreign keys prevent cross-organisation and cross-project references. PostgreSQL RLS is not enabled. The runtime database role can administer the evaluation database; production needs separate migration/runtime roles and a reviewed RLS strategy. Immutable triggers prevent ordinary updates and deletes, not changes by a database administrator.

The local bootstrap is not a hosted identity system. There is no invitation flow, token-management UI, token expiry, SSO, session cookie, or custom-role editor. Tokens are permission-scoped, but not yet project- or environment-scoped. Keep the development services bound to loopback. The browser does not persist credentials.

Deployment outbox entries are durable but have no delivery worker. Artifact ingestion has a separate PostgreSQL-backed worker; it does not execute deployments or substitute for Temporal. Agent registration, Temporal, Redis, deployment secrets management, targets, verified deployment outcomes, staging-before-production promotion, rollback, runbooks, tenants, scheduled releases, and production packaging remain unimplemented. Successful staging is not required before requesting production in this increment; production approval still applies.

The dashboard shows the newest request per environment, including its pending/cancelled state. It does not claim that this is the currently deployed version. The latest 200 records per resource are loaded; pagination is a follow-up before supporting larger installations.

## Ingestion boundaries

Connections use a repository-scoped GitHub token with Actions read permission. There is no GitHub App installation, OAuth flow or automatic token renewal. The encryption key stays in server configuration and must be backed up separately from PostgreSQL; automatic master-key rotation is not implemented. Provider tokens and webhook secrets can be rotated through the UI, API or CLI.

Imports are limited to 25 MiB, current successful run attempts, one configured artifact name, and 1,000 artifacts/workflows per discovery operation. The downloaded ZIP remains opaque; no extraction occurs. Keel requires GitHub's SHA-256 metadata rather than accepting unverified legacy artifacts. Webhooks queue imports only. Operators create releases from retained artifacts through the existing release flow.

Tests use GitHub HTTP fixtures, real PostgreSQL and a real local S3-compatible RustFS service. No live GitHub repository is connected by the test suite. The object store in Compose is for local evaluation, not production packaging.

## Design

The original visual reference is [overview-reference.png](design/overview-reference.png). The revised [nautical reference](design/overview-nautical.png) is the implementation reference: navy `#102d40`, sea teal `#226d75`, off-white `#f8faf9`, and brass for attention states. The reference was produced with the built-in image generator, then adjusted in code for contrast and responsive layout.

The design prompt requested a restrained continuous-delivery dashboard, a navy sidebar, sea-teal actions, an off-white canvas, and a small line-drawn boat in the empty state. It preserved the overview metrics and environment table and excluded decorative ropes, anchors, or invented deployment activity. The boat loader moves slightly along a short waterline; reduced-motion mode disables both animations.

Technical references used during implementation: [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) and [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).
