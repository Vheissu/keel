# Notifications

Keel sends signed HTTPS webhooks when a deployment or runbook run enters a selected state. A destination can cover the whole workspace or one project and/or environment, and chooses its event sources: deployments (including rollbacks), runbook runs or both. The event and its delivery jobs commit in the same PostgreSQL transaction. New destinations receive future events only.

The Notifications screen shows destinations, delivery status, attempt history and the next retry time. Use **Refresh notifications** to fetch current state. Operators can create and disable destinations or retry a failed delivery; readers can inspect metadata. Native Slack, Teams, email and incident-management adapters are not implemented. A webhook receiver can translate Keel events for those services.

## Configure delivery

Set these on both the API and notification worker:

```dotenv
KEEL_CREDENTIAL_KEY=<the existing base64-encoded 32-byte credential key>
KEEL_NOTIFICATION_ORIGINS=https://alerts.example.com,https://hooks.example.com
```

The allowlist contains exact origins, including a port when it is not 443. Only HTTPS is accepted. URL credentials, fragments and redirects are rejected. The server administrator controls the allowlist: only approve hosts you trust, including their DNS and network access. An approved host may be on a private network. Keel does not implement a public-IP-only DNS filter; use outbound firewall rules when network isolation is required.

`npm run dev` starts the notification worker alongside the API, browser and import worker. For a compiled installation, run `npm run worker:notifications`. The self-hosted Compose package starts a separate `notification-worker` service with its own health check. Export `KEEL_NOTIFICATION_ORIGINS` when running self-host commands so the API and worker receive the same allowlist. It is not saved in `installation.json`; reapply it after a restart or restore.

Create a destination in **Notifications**, or save a CLI configuration:

```json
{
  "name": "Production alerts",
  "url": "https://alerts.example.com/keel",
  "environment_id": "<production-environment-uuid>",
  "statuses": ["awaiting_approval", "reconciliation_required", "succeeded", "failed"],
  "work_kinds": ["deployment", "runbook"]
}
```

```sh
# Supply a random signing secret through your shell's secret environment mechanism.
# KEEL_NOTIFICATION_SECRET must contain 32–256 printable non-space ASCII characters.
npm run keel -- notification create --config webhook.json
npm run keel -- list notification-deliveries --status failed
npm run keel -- list notification-attempts --delivery <delivery-uuid>
npm run keel -- notification retry <delivery-uuid>
npm run keel -- notification disable <endpoint-uuid> --revision 1
```

Optional `project_id` and `environment_id` must belong to the workspace. Omit them, or use JSON `null`, to include all projects or environments. Supported states are `awaiting_approval`, `queued`, `running`, `cancel_requested`, `reconciliation_required`, `succeeded`, `failed`, `cancelled` and `rejected`; they apply to every selected source. `work_kinds` accepts `deployment` and `runbook` and defaults to `["deployment"]`, so receivers written for deployment payloads never receive runbook events unless the destination opts in. Filter delivery history by run with `--deployment <run-uuid>`.

Destination URLs and signing secrets are encrypted with AES-256-GCM under a notification-specific context. Metadata responses expose the origin, never the URL path, query or signing secret. Keep the secret in the receiver too; Keel has no value-read endpoint. URLs, secrets, scopes, sources and state rules are immutable. Disable a destination and create a replacement to change them. Disable takes a revision to reject stale edits, cancels pending retries and stops new events. An HTTP request already in progress may finish. Re-enabling receives new events; cancelled jobs require an explicit retry.

## Receiver contract

Requests use `POST` with `Content-Type: application/json` and these headers:

- `X-Keel-Delivery`: stable delivery UUID, reused for every automatic or manual attempt.
- `X-Keel-Timestamp`: Unix seconds for this attempt.
- `X-Keel-Signature`: `sha256=<lowercase hex HMAC>`.

The HMAC key is the signing secret. Its input is the exact UTF-8 concatenation of the timestamp, a dot, delivery UUID, another dot and the raw request body:

```js
const expected = createHmac('sha256', signingSecret)
  .update(`${timestamp}.${deliveryId}.`)
  .update(rawBody)
  .digest();
```

Validate header syntax and compare equal-length decoded signatures with `timingSafeEqual`. Check the timestamp against a short tolerance, such as five minutes, using a synchronized clock. Authenticate before parsing or acting on the payload. Store the delivery UUID durably with the receiver's accepted work so a retry cannot repeat its effects. Return a 2xx only after that acceptance is durable, including for an already accepted UUID.

Payloads have this shape:

```json
{
  "schema_version": 1,
  "event_id": "<event-uuid>",
  "type": "deployment.failed",
  "occurred_at": "2026-10-13T00:00:00+00:00",
  "deployment": {
    "id": "<deployment-uuid>",
    "status": "failed",
    "kind": "deploy",
    "project_id": "<project-uuid>",
    "project_name": "Customer portal",
    "environment_id": "<environment-uuid>",
    "environment_name": "Production",
    "release_id": "<release-uuid>",
    "release_version": "1.2.3",
    "result_code": "NO_TARGET"
  }
}
```

Runbook run events use `runbook.<state>` types and a `runbook_run` object instead of `deployment`:

```json
{
  "schema_version": 1,
  "event_id": "<event-uuid>",
  "type": "runbook.succeeded",
  "occurred_at": "2026-10-13T00:00:00+00:00",
  "runbook_run": {
    "id": "<run-uuid>",
    "status": "succeeded",
    "project_id": "<project-uuid>",
    "project_name": "Customer portal",
    "environment_id": "<environment-uuid>",
    "environment_name": "Production",
    "runbook_id": "<runbook-uuid>",
    "runbook_name": "Rotate caches",
    "runbook_slug": "rotate-caches",
    "runbook_version_id": "<version-uuid>",
    "runbook_version": 3,
    "runbook_schedule_id": null,
    "scheduled_for": null,
    "result_code": null
  }
}
```

Dispatch on `type` and ignore unknown types. Each payload is an event-time snapshot. Deployment `kind` can also be `rollback`; `result_code` can be null in either shape. `runbook_schedule_id` and `scheduled_for` identify runs created by a [schedule](runbooks.md#schedules) and are null for manual runs. Runbook payloads exclude task commands, reviewed input values and secret bindings. Payloads exclude deployment secrets, process manifests, credentials and logs. Delivery is at least once and may arrive out of order. Use the event timestamp and event ID when building a history; fetch authoritative deployment or run state when a receiver needs its current status.

## Retries and recovery

Each attempt has a 10-second network deadline. Workers claim jobs using PostgreSQL row locks, a unique lease token and a 45-second lease. A replacement worker can reclaim an expired lease; a stale worker cannot overwrite its result. If a receiver accepted a request just before a worker crashed, the same delivery may be sent again.

Network failures, HTTP 408, 425, 429 and 5xx responses retry up to six attempts. Delays start at 30 seconds and double, with up to 20% jitter. A numeric or HTTP-date `Retry-After` can extend the delay, capped at one hour. Other HTTP responses, including redirects, fail immediately. Decryption failure or an origin removed from the allowlist also fails immediately. A manual retry starts another six-attempt budget and preserves the delivery ID and all previous attempt records.

The history records HTTP status and fixed result codes. Response bodies and network error text are not stored. `delivered` means the receiver returned a 2xx; it does not prove a downstream chat or email was received. `LEASE_EXPIRED` means Keel cannot establish whether that attempt reached the receiver.

A stopped worker leaves queued work in PostgreSQL and resumes it after restart. Notification failures do not change deployment or runbook outcomes. Cold backups include notification configuration, encrypted credentials, jobs and attempts. Restore verifies that destination credentials can be decrypted, disables all destinations and cancels unfinished jobs with `RESTORE_QUARANTINE`. Reapply the origin allowlist, review delivery history and enable destinations deliberately before retrying any old job. Receivers should retain their deduplication records across a Keel restore.
