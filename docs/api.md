# API foundation

The API prefix is `/api/v1`. Resource routes accept `Authorization: Bearer <token>`. Hosted identity also supports browser sessions with an active `X-Workspace-ID` membership and CSRF protection. Bearer scope always comes from the token; a conflicting workspace header is rejected. See [identity endpoints](identity.md#api). Public `GET /health` checks database connectivity and reports `agent-protocol-available`; this does not confirm that a worker or agent is running.

Resource mutations require an `Idempotency-Key` header: 8–128 letters, numbers, dots, colons, underscores, or hyphens. Keys are scoped to organisation and actor. The request method, URL, and body are fingerprinted. Retrying the same request returns its saved response (one-time token values and invitation links are omitted on replay); reusing a key for a different request returns `409`. Keys currently have no expiry.

| Method and path                 | Permission | Input / result                                                                     |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `GET /resources/:resource`      | read       | Paginated items, filtered total and next/previous cursors                          |
| `GET /resources/:resource/:id`  | read       | One scoped record, including related display names                                 |
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

## Paginated resource reads

`GET /api/v1/resources/:resource` returns `{items, total, limit, next_cursor, previous_cursor}`. The default limit is 25; any integer from 1 to 100 is accepted. `q` performs case-insensitive substring search across the resource's display fields, with a maximum of 200 characters. Percent signs and underscores are literal characters. Unknown parameters and unsupported filters return `400`.

| Resource                               | Optional filters                                    |
| -------------------------------------- | --------------------------------------------------- |
| `projects`, `environments`, `audit`    | None                                                |
| `artifacts`, `releases`, `connections` | `project_id`                                        |
| `deployments`                          | `project_id`, `environment_id`, `status`            |
| `agents`                               | `state`                                             |
| `targets`                              | `project_id`, `environment_id`, `agent_id`          |
| `attempts`                             | `agent_id`, `state`                                 |
| `imports`                              | `project_id`, `connection_id`, `status`             |
| `secrets`                              | Both `project_id` and `environment_id` are required |

Results are ordered by creation time and UUID, newest first. Cursors preserve PostgreSQL microseconds and are bound to the organisation, resource, search and filters. Pass either returned cursor with the same filters to move in that direction. Treat cursors as opaque positions, not credentials. Every request still checks the token and organisation. A cursor used with different filters returns `INVALID_CURSOR`; omit it to restart. Page size may change, although the UI starts a fresh first page when it does.

The first page anchors the upper position, so records created later do not shift an ongoing walk. Return to the first page to include those records. Each response reads its items and exact filtered total within one database snapshot. The total includes newer matching records outside the cursor anchor. Pages do not freeze mutable values or filter membership across requests: a state change can move a record into or out of a filtered result. Backdated inserts can also appear below the anchor.

`GET /api/v1/resources/:resource/:id` returns one record or `404` for an inaccessible record. Related names are joined on the server, including when they fall outside the overview window. Connection credentials, import lease tokens, agent certificate fingerprints, deployment lease hashes and secret values are excluded. Secret lookups return metadata only; they never join encrypted versions. Both routes send `Cache-Control: no-store`.

The UI stores list search, cursor and size in the URL fragment. Secret pages also store the selected project and environment. Form selectors load bounded pages and retain the selected record when searching or paging through other choices. The CLI uses the same endpoint:

```sh
npm run keel -- list releases --project <project-uuid> --search 1.2 --limit 25
npm run keel -- list releases --project <project-uuid> --search 1.2 --limit 25 --cursor '<next_cursor>'
npm run keel -- list deployments --environment <environment-uuid> --status failed
npm run keel -- list secrets --project <project-uuid> --environment <environment-uuid>
```

Indexes support organisation and common scope ordering. Exact counts and substring searches can still scan the matching collection; pagination bounds response size, not total database work.

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

The API rate limit is 180 requests per minute per IP in one API process. Distributed rate limiting is not implemented. The overview and legacy `/snapshot`, `/integrations` and `/execution` responses retain their 200-record windows; use `/resources/:resource` for complete navigation. Existing CLI `status`, `integration list` and `secret list` commands keep their response shapes.

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

| Method and path          | Permission | Input / result                                                                                                            |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /execution`         | read       | Latest 200 agents, targets and attempts; no lease credentials                                                             |
| `POST /agents`           | write      | `{name, certificate_fingerprint}`; lowercase SHA-256 certificate fingerprint                                              |
| `POST /agents/:id/state` | write      | `{state: "active"                                                                                                         | "draining" | "revoked"}`; revoked identities cannot resume |
| `POST /targets`          | write      | `{name, project_id, environment_id, agent_id, labels, capability?}`; local/SSH Docker recreate or local Docker blue/green |

`capability` accepts `docker-recreate-v1` (default) or `ssh-docker-recreate-v1`. SSH connection details and credentials stay in the private agent configuration. Polling agents must advertise `ssh-docker-recreate-v1` to claim SSH deployment or reconciliation work. The returned job includes its target capability.

These mutations require idempotency keys. Target bindings are immutable in this increment. A target's `current_release_id` is present only when `current_state` is `verified`. `reconciliation_required` and `cancel_requested` deployments continue holding their environment and target locks. Result codes contain no agent-provided text.

The separate HTTPS gateway provides `POST /agent/v1/poll`, `/heartbeat`, `/artifact`, `/secrets` and `/result`. All require a registered trusted client certificate. Poll returns one assigned job or `null`. Other requests include `{attempt_id, fence, token}`; result also includes an allowed outcome/code pair. Artifact and secret access are limited to the active deployment. Revocation, cancellation, expiry and superseded fences are checked server-side. [Protocol, setup and recovery limits](deployment-agents.md).

### Agent certificate recovery and progress

`POST /api/v1/agents/:id/certificate` takes `certificate_fingerprint` and `same_host_agent_stopped: true`, with write permission and an idempotency key. The agent must be drained or revoked and have no running/reconciling lease. Replacement retains the agent ID and target locks, permanently retires the old fingerprint and leaves the agent draining. Resume is blocked until outstanding reconciliation completes.

The private mTLS gateway accepts `POST /agent/v1/progress` with the current lease fields and a fixed `phase`: `downloading`, `loading_image`, `pre_hook`, `replacing_container`, `starting_candidate`, `switching_traffic`, `verifying_http`, `post_hook` or `cleaning_up`. Recovery/cancellation permits only `cleaning_up`. No free-text output is accepted. `/api/v1/execution` exposes `phase` and `phase_updated_at` per attempt. See [same-host recovery](deployment-agents.md#replace-or-recover-an-agent-certificate).

## Promotion policy and rollback plans

- `GET /api/v1/releases/:id/promotion?environment_id=<uuid>` reports promotion eligibility, prerequisite evidence, approval requirement and digest. It does not reserve a target.
- `POST /api/v1/environments/:id/promotion-policy` requires **approve** permission and `{ "promotion_from_environment_id": "<uuid-or-null>", "expected_revision": 1 }`. Use JSON `null`, not the string `"null"`, to remove a prerequisite. The referenced environment must be in the same workspace; cycles are rejected.
- `GET /api/v1/deployments/:id/rollback-candidates` returns a page of at most 50 distinct releases previously verified on the source deployment's target and environment. The source must be the target's latest finished attempt with no outstanding deployment lock. Pass the returned `next_cursor` as `?cursor=...` to read older releases; a null cursor marks the last page. Deduplication occurs before pagination, so repeated verifications do not repeat a release on later pages. The CLI accepts `deployment rollback-candidates <id> --cursor <cursor>`.
- `POST /api/v1/rollback-plans` requires **write** permission and `{ "source_deployment_id": "<uuid>", "candidate_deployment_id": "<uuid>" }`. It verifies the retained bytes and current execution/promotion contract, then returns a 15-minute immutable plan and review details.
- `POST /api/v1/rollback-plans/:id/request` requires **write** permission and `{ "acknowledge_data_not_restored": true }`. It rechecks the plan and creates one ordinary deployment with `kind: "rollback"`; approval is not bypassed.

All writes require an idempotency key. Deployments expose `kind`, `policy_snapshot`, `promotion_source_deployment_id` and `rollback_plan_id`. These admission fields cannot be edited. Policy changes apply to new requests. Normal `/deployments` requests cannot supply rollback or promotion evidence fields. See [policy and rollback semantics](promotion-and-rollback.md).

## Deployment secrets

| Method and path                                        | Permission     | Input / result                                                      |
| ------------------------------------------------------ | -------------- | ------------------------------------------------------------------- |
| `GET /secrets?project_id=<uuid>&environment_id=<uuid>` | read           | Secret metadata in the exact scope; no values                       |
| `POST /secrets`                                        | manage_secrets | `{project_id, environment_id, name, value}`; creates version 1      |
| `POST /secrets/:id/versions`                           | manage_secrets | `{value, expected_revision}`; adds a version and enables new use    |
| `POST /secrets/:id/revoke`                             | manage_secrets | `{expected_revision}`; disables the secret and revokes all versions |
| `GET /deployments/:id/secret-bindings`                 | read           | `{variable, name, version, revoked_at}` records pinned at admission |

Secret managers also require `read`. Responses contain metadata only and disable caching. Names and container variable names match `[A-Z][A-Z0-9_]{0,63}`. Values contain 1–8192 UTF-8 bytes without NUL, CR or LF. Secret create/rotate bodies are capped at 64 KiB to allow JSON escaping. There is no value-read endpoint. Creation and rotation use keyed HMAC request fingerprints; idempotent responses never contain values.

Process environment entries may contain `secrets: { "APP_PASSWORD": { "secret": "DATABASE_PASSWORD" } }`, with at most 32 references. `/releases/:id/promotion` includes `secret_bindings` with `{variable, name, version, available}` and reports ineligible if a reference is missing or disabled. Deployment admission pins current versions transactionally. `/rollback-plans` includes its reviewed `secret_bindings`; a change before request invalidates the plan.

Gateway polling accepts `{ "capabilities": ["deployment-secrets-v1"] }`. Omission remains valid for older agents, which cannot claim secret-bearing deployments. Jobs include `secret_count`, never values. `POST /agent/v1/secrets` accepts the ordinary lease fields and returns `{ "values": { "APP_PASSWORD": "..." } }` only for that agent's running deployment. Cleanup assignments, cancelled work, expired leases and revoked versions are denied. Responses set `Cache-Control: no-store` and `Pragma: no-cache`. `SECRET_UNAVAILABLE` is a fixed failure code; agents cannot submit arbitrary error text. See [deployment secrets](deployment-secrets.md) for pinning, rotation and exposure boundaries.

## Deployment notifications

| Method and path                            | Permission | Input / result                                                                                         |
| ------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------ |
| `GET /notifications/configuration`         | read       | Credential-key configuration status and allowed origins                                                |
| `POST /notifications/endpoints`            | write      | `{name, url, signing_secret, statuses, project_id?, environment_id?}`; encrypted immutable destination |
| `POST /notifications/endpoints/:id/state`  | write      | `{enabled, expected_revision}`; toggle future delivery and cancel pending jobs on disable              |
| `POST /notifications/deliveries/:id/retry` | write      | Empty body; retry a failed or cancelled job to an enabled destination                                  |
| `GET /resources/notification-endpoints`    | read       | Destination metadata; optional `project_id`, `environment_id` filters                                  |
| `GET /resources/notification-deliveries`   | read       | Delivery metadata; optional `endpoint_id`, `deployment_id`, `status` filters                           |
| `GET /resources/notification-attempts`     | read       | Attempt history; optional `delivery_id` filter                                                         |

All writes require an idempotency key. Resource collections support ordinary pagination, search and scoped `/:id` lookups. Destination creation accepts at most 8 KiB and returns neither the URL path/query nor signing secret. Delivery status is `pending`, `sending`, `retrying`, `delivered`, `failed` or `cancelled`. See [notification setup, signatures and retry semantics](notifications.md).

## Deployment lifecycle hooks

Process environments accept optional `hooks: {preDeploy?, postDeploy?}`. Each hook requires `command` (1–32 nonempty argument strings, each at most 256 characters without control characters) and `timeoutSeconds` (integer, 1–120). Optional `secrets` selects up to 32 unique variables declared by the environment. Optional `network` accepts `none` (default) or `target`, which requires the private agent’s configured Docker network. Unknown fields, empty hook objects and undeclared secret variables are rejected. There is no continue-on-failure policy.

Polling agents advertise `deployment-hooks-v1` alongside their existing capabilities. Both deployment and cleanup jobs for hook-bearing releases require this capability and include the retained hook definitions. Cleanup jobs cannot retrieve secrets and never execute hooks. Progress adds `pre_hook` and `post_hook`; fixed failure codes add `PRE_HOOK_FAILED`, `PRE_HOOK_TIMEOUT`, `POST_HOOK_FAILED`, `POST_HOOK_TIMEOUT`, `HOOK_NETWORK_UNAVAILABLE` and `HOOK_STATE_FAILED`. Only completion of hooks and final HTTP verification permits success. Rollback review warns when hooks will run again. See [execution limits and failure behavior](lifecycle-hooks.md).

## Runbooks

[Runbook endpoints and CLI commands](runbooks.md#cli-and-api) create immutable versions, review exact targets and request bounded tasks. The `runbooks`, `runbook-versions` and `runbook-runs` resources support paginated reads and individual lookups. All three accept project/environment filters; versions accept `runbook_id`, and runs accept `runbook_version_id` and `status`.

Runbook processes can declare bounded string, integer, boolean and enum inputs. `POST /runbook-plans` accepts an optional `inputs` object and returns the fully resolved `input_values`, including defaults. Those values are immutable and appear in run reads and approval audits. Request and approval bodies accept only the acknowledgement; changing inputs requires another review. Agents must advertise `runbook-inputs-v1` to claim tasks with inputs. Their jobs include `runbook_inputs` as string values for literal `KEEL_INPUT_*` environment delivery. Cleanup jobs omit values and never execute the task.

Run requests and approvals require `acknowledge_external_effects: true`. Definition, version, review, request and cancellation writes require `write`; approval and rejection require `approve`. Existing project/environment scopes and separate-actor approval apply. Runbook requests do not appear in the deployment resource or count as verified releases.
