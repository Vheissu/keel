# API foundation

The API prefix is `/api/v1`. Every resource route requires `Authorization: Bearer <token>`. Organisation and actor IDs come from the token, never from a caller-supplied organisation header or body. Public `GET /health` checks database connectivity and reports that execution is not configured.

Resource mutations require an `Idempotency-Key` header: 8–128 letters, numbers, dots, colons, underscores, or hyphens. Keys are scoped to organisation and actor. The request method, URL, and body are fingerprinted. Retrying the same request returns its saved response; reusing a key for a different request returns `409`. Keys currently have no expiry.

| Method and path                 | Permission | Input / result                                                                     |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `GET /snapshot`                 | read       | Workspace, principal, totals, latest 200 records per resource                      |
| `POST /projects`                | write      | `{name, slug, description?}`                                                       |
| `POST /artifacts`               | write      | Binary bytes; query parameters `project_id`, `name`, `version`, `digest`           |
| `GET /artifacts/:id/download`   | read       | Verified retained bytes                                                            |
| `POST /releases`                | write      | `{project_id, artifact_id, version, process}`                                      |
| `POST /deployments`             | write      | `{release_id, environment_id}`                                                     |
| `POST /deployments/:id/approve` | approve    | Empty body; different actor required                                               |
| `POST /deployments/:id/reject`  | approve    | Empty body; different actor required                                               |
| `POST /deployments/:id/cancel`  | write      | Empty body                                                                         |
| `POST /processes/validate`      | read       | `{process}`; YAML string or JSON object; no idempotency key required               |
| `GET /providers`                | read       | Implemented adapters and their read, trigger, deployment and rollback capabilities |

Tokens also require `read` to use resource routes. Unknown input properties are rejected. UUID references must resolve inside the authenticated organisation. Published artifacts and releases return their stored record. Mutations return `200`, including idempotent replay.

Artifact publishing requires `Content-Type: application/octet-stream`, nonempty content, and a lowercase hex SHA-256 digest. The current limit is 25 MiB. Keel computes the digest from the received bytes before creating metadata. Downloads verify it again. The uploaded file is opaque; no archive extraction or script execution occurs.

Release manifests capture the artifact ID, digest, size, provenance, and parsed process. Direct uploads record the authenticated publisher. They do not claim verified CI provenance. Artifact versions and release versions cannot be replaced. An existing version returns `409`.

## Deployment state

```text
unprotected request → queued → cancelled
protected request   → awaiting_approval → queued → cancelled
                                       → rejected
                                       → cancelled
```

The environment policy and process policy are combined with OR: either can require approval. YAML cannot disable the production environment’s approval requirement. Approved requests queue for the Temporal worker. Only the separate mTLS agent gateway accepts execution results under a current fenced lease. Operator API tokens cannot submit success.

Each project/environment pair has at most one pending, queued, running, cancelling or reconciliation-required request, enforced by a partial unique database index. Rejection and cancellation before execution release that lock. Active cancellation keeps it until target cleanup is confirmed. State changes lock the deployment row and commit with append-only deployment events, audit events, and transactional outbox entries. Cancellation rejects later approval attempts.

Deployment requests and approval both recheck the retained artifact. Missing or corrupt bytes leave the request unqueued or unapproved. The execution worker reads authoritative deployment state, and the agent rechecks its lease before replacing a target. Both storage and agent verify the retained bytes.

## Errors and limits

Errors use `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`. Common status codes are `400` for validation or digest mismatches, `401` for invalid or revoked tokens, `403` for permission or self-approval failures, `404` for inaccessible references, and `409` for version conflicts, environment locks, invalid transitions, missing blobs, and corrupted blobs. Internal database details are not returned.

The API rate limit is 180 requests per minute per IP in one API process. The snapshot is an evaluation interface with a 200-record window; totals cover all stored records. Cursor pagination and distributed rate limits are still needed before larger deployments. The UI discloses truncated lists.

## Provider connections and imports

| Method and path                      | Permission | Input / result                                                                              |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| `GET /integrations`                  | read       | Latest 200 connections and imports; credential-key configuration status                     |
| `POST /integrations/github`          | write      | `{name, project_id, repository, workflow_id, branch, artifact_name, token, webhook_secret}` |
| `POST /integrations/:id/credentials` | write      | `{token, webhook_secret}`; validates access, rotates both secrets                           |
| `POST /integrations/:id/state`       | write      | `{enabled}`                                                                                 |
| `GET /integrations/:id/pipelines`    | read       | GitHub workflows, with pagination handled by the adapter                                    |
| `POST /integrations/:id/imports`     | write      | `{run_id, run_attempt?}`; queues a durable import, default attempt 1                        |
| `POST /imports/:id/retry`            | write      | Empty body; resets a failed import for another bounded set of attempts                      |

All IDs supplied by clients for GitHub runs and workflows are decimal strings. A connection fixes its project, repository, workflow, branch and artifact name. Create a new connection to change that policy. Credentials are encrypted with AES-256-GCM and are excluded from response projections, idempotency responses and audit details. Disabling or rotating a connection invalidates in-flight work that was verified with the previous credential revision.

`POST /webhooks/github/:connectionId` is outside `/api/v1` and uses GitHub HMAC authentication instead of a Keel token. It requires `X-Hub-Signature-256`, a UUID `X-GitHub-Delivery`, `X-GitHub-Event`, and the exact JSON bytes signed by GitHub. Payloads are limited to 512 KiB. Verified deliveries return `202` with `{outcome: "accepted" | "ignored", duplicate: boolean}`. Reusing a delivery ID with a different event or payload returns `409`. A new delivery ID for the same connection/run/attempt still resolves to one import.

The worker retrieves authoritative GitHub metadata, enforces the connection policy, requires a successful current run attempt, selects exactly one artifact with the configured name created during that attempt, verifies its SHA-256 checksum, and retains its ZIP archive. Pull-request events and fork sources are rejected. Imported versions use `gh-<run-id>.<attempt>.<artifact-id>`. Provenance records repository, workflow, commit, branch, run URL, original status, artifact ID and provider digest. Releases copy that provenance into their immutable manifest.

Imports move from `pending` to `processing`, then `succeeded` or `failed`. Retryable provider/storage errors return to `pending` with persisted backoff. Workers claim rows with `SKIP LOCKED`, renew a two-minute lease, and fence completion with a lease token. Five attempts are allowed before an explicit operator retry is needed. A crashed worker's expired lease can be reclaimed. Import records expose safe error codes/messages, attempts and the next eligible time, never provider response bodies or signed download URLs.

GitHub Actions supports workflow discovery, run reads and artifact ingestion. Other provider adapters remain unavailable. Triggering/cancelling CI, provider deployment, rollback, GitHub App installation/OAuth, automatic release creation and provider-owned deployment are not implemented. See [GitHub setup](github-actions.md).

## Bitbucket publishing

`POST /api/v1/integrations/bitbucket` creates a connection using `name`, `project_id`, `repository`, `workflow_id` (for example `branches:main`), `branch`, `artifact_name`, `token` and `publish_secret`. The operator needs `write` permission and an idempotency key. `token` is a Bitbucket repository access token. `publish_secret` is a random 32–256 character string containing letters, digits, underscores or hyphens.

`POST /api/v1/integrations/:id/bitbucket-credentials` rotates `token` and `publish_secret` together under the same permission/idempotency rules. Existing list, enable/disable and import-retry endpoints work for both providers. Credentials never appear in responses. Bitbucket workflow/artifact discovery and the GitHub manual-import endpoint return `UNSUPPORTED_OPERATION` for Bitbucket connections.

`POST /publish/bitbucket/:id` accepts raw `application/octet-stream` bytes, capped at 25 MiB. It requires the connection's publishing secret as `Authorization: Bearer <secret>` and these headers:

| Header                 | Value                                        |
| ---------------------- | -------------------------------------------- |
| `X-Bitbucket-Pipeline` | Pipeline UUID, with or without braces        |
| `X-Bitbucket-Step`     | Publishing step UUID, with or without braces |
| `X-Bitbucket-Commit`   | 40-character lowercase commit SHA            |
| `X-Artifact-Sha256`    | SHA-256 of the exact uploaded bytes          |

The API verifies that the run and step are currently running and match the connection policy. A successful response is `202` with the import ID, status and `duplicate` flag. The tuple of connection and pipeline UUID identifies a submission; identical retries return the same job, while changed content or step metadata returns `PUBLISH_CONFLICT`. No operator API token is required or accepted as a substitute for the publishing secret.

The worker waits for both pipeline and step success, rechecks the run and bytes, and publishes artifact metadata under its current lease and connection revision. Pending blobs cannot be selected for a release. Failed or untrusted runs produce visible failed imports. Normal completion polling waits up to 24 hours and does not consume the five transient-error retries. Artifact provenance explicitly labels the digest as publisher-supplied. [Setup and trust boundaries](bitbucket-pipelines.md).

Provider capability responses include `artifactIngestion`: `provider-download` for GitHub, `publishing-step` for Bitbucket, and `unavailable` for unimplemented adapters. Bitbucket reports run lookup support; workflow/artifact discovery, triggering, cancellation and deployment capabilities remain false.

## Agent and target management

| Method and path          | Permission | Input / result                                                                           |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------- |
| `GET /execution`         | read       | Latest 200 agents, targets and attempts; no lease credentials                            |
| `POST /agents`           | write      | `{name, certificate_fingerprint}`; lowercase SHA-256 certificate fingerprint             |
| `POST /agents/:id/state` | write      | `{state: "active"                                                                        | "draining" | "revoked"}`; revoked identities cannot resume |
| `POST /targets`          | write      | `{name, project_id, environment_id, agent_id, labels}`; fixed Docker recreate capability |

These mutations require idempotency keys. Target bindings are immutable in this increment. A target's `current_release_id` is present only when `current_state` is `verified`. `reconciliation_required` and `cancel_requested` deployments continue holding their environment and target locks. Result codes contain no agent-provided text.

The separate HTTPS gateway provides `POST /agent/v1/poll`, `/heartbeat`, `/artifact` and `/result`. All require a registered trusted client certificate. Poll returns one assigned job or `null`. Other requests include `{attempt_id, fence, token}`; result also includes an allowed outcome/code pair. Artifact access is limited to that active deployment's retained blob. Revocation, cancellation, expiry and superseded fences are checked server-side. [Protocol, setup and recovery limits](deployment-agents.md).

### Agent certificate recovery and progress

`POST /api/v1/agents/:id/certificate` takes `certificate_fingerprint` and `same_host_agent_stopped: true`, with write permission and an idempotency key. The agent must be drained or revoked and have no running/reconciling lease. Replacement retains the agent ID and target locks, permanently retires the old fingerprint and leaves the agent draining. Resume is blocked until outstanding reconciliation completes.

The private mTLS gateway accepts `POST /agent/v1/progress` with the current lease fields and a fixed `phase`: `downloading`, `loading_image`, `replacing_container`, `verifying_http` or `cleaning_up`. Recovery/cancellation permits only `cleaning_up`. No free-text output is accepted. `/api/v1/execution` exposes `phase` and `phase_updated_at` per attempt. See [same-host recovery](deployment-agents.md#replace-or-recover-an-agent-certificate).
