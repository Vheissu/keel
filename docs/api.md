# API foundation

The API prefix is `/api/v1`. Every resource route requires `Authorization: Bearer <token>`. Organisation and actor IDs come from the token, never from a caller-supplied organisation header or body. Public `GET /health` checks database connectivity and reports that execution is not configured.

All mutations require an `Idempotency-Key` header: 8–128 letters, numbers, dots, colons, underscores, or hyphens. Keys are scoped to organisation and actor. The request method, URL, and body are fingerprinted. Retrying the same request returns its saved response; reusing a key for a different request returns `409`. Keys currently have no expiry.

| Method and path                 | Permission | Input / result                                                           |
| ------------------------------- | ---------- | ------------------------------------------------------------------------ |
| `GET /snapshot`                 | read       | Workspace, principal, totals, latest 200 records per resource            |
| `POST /projects`                | write      | `{name, slug, description?}`                                             |
| `POST /artifacts`               | write      | Binary bytes; query parameters `project_id`, `name`, `version`, `digest` |
| `GET /artifacts/:id/download`   | read       | Verified retained bytes                                                  |
| `POST /releases`                | write      | `{project_id, artifact_id, version, process}`                            |
| `POST /deployments`             | write      | `{release_id, environment_id}`                                           |
| `POST /deployments/:id/approve` | approve    | Empty body; different actor required                                     |
| `POST /deployments/:id/reject`  | approve    | Empty body; different actor required                                     |
| `POST /deployments/:id/cancel`  | write      | Empty body                                                               |
| `POST /processes/validate`      | read       | `{process}`; YAML string or JSON object; no idempotency key required     |
| `GET /providers`                | read       | Planned providers; all currently `available: false`                      |

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

The environment policy and process policy are combined with OR: either can require approval. YAML cannot disable the production environment’s approval requirement. Approved requests remain queued because execution is not connected. No endpoint accepts a caller-supplied success state.

Each project/environment pair has at most one pending or queued request, enforced by a partial unique database index. Cancellation or rejection releases that lock. State changes lock the deployment row and commit with append-only deployment events, audit events, and transactional outbox entries. Cancellation rejects later approval attempts.

Deployment requests and approval both recheck the retained artifact. Missing or corrupt bytes leave the request unqueued or unapproved. An execution worker must recheck policy, cancellation, and artifact integrity immediately before execution when that worker is implemented.

## Errors and limits

Errors use `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`. Common status codes are `400` for validation or digest mismatches, `401` for invalid or revoked tokens, `403` for permission or self-approval failures, `404` for inaccessible references, and `409` for version conflicts, environment locks, invalid transitions, missing blobs, and corrupted blobs. Internal database details are not returned.

The API rate limit is 180 requests per minute per IP in one API process. The snapshot is an evaluation interface with a 200-record window; totals cover all stored records. Cursor pagination and distributed rate limits are still needed before larger deployments. The UI discloses truncated lists.

## Provider adapters

`packages/integrations` defines provider connections, normalised runs, artifacts, and capability discovery. GitHub Actions, Bitbucket Pipelines, Azure Pipelines, GitLab CI/CD, and Jenkins are declared but not connected. No API claims it can trigger or cancel their pipelines.

A provider implementation must retain verified artifact bytes before creating a release, preserve the original provider status, scope credentials by organisation, and verify/deduplicate webhook deliveries. A CI job can publish directly through the current upload endpoint or CLI while those adapters are being built.
