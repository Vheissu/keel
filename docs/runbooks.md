# Reviewed runbooks

Runbooks execute one fixed operational command from a retained Docker image. They belong to a project and environment and have immutable numbered versions. Use them for short maintenance tasks that can finish within 120 seconds. They use the same private agents, environment locks, approval checks and encrypted secret delivery as deployments.

## Publish and review a task

Publish a Docker image archive through the existing artifact flow. The image must contain `/bin/timeout` and the task command, and support execution as user `65532:65532` with a read-only filesystem. A ZIP can contain the image archive; set `dockerArchivePath` to its exact entry. The 25 MiB artifact limit still applies.

Open **Runbooks**, create a definition in the intended project and environment, then select the artifact and publish a process such as:

```yaml
apiVersion: keel.dev/v1alpha1
kind: Runbook
spec:
  artifact:
    dockerImageId: sha256:REPLACE_WITH_THE_64_HEX_CHARACTER_IMAGE_ID
  task:
    command: ['/app/check-cache', '--read-only']
    timeoutSeconds: 30
    network: target
  secrets:
    CACHE_PASSWORD:
      secret: CACHE_PASSWORD
  requiresApproval: true
```

Commands are argument arrays: Keel does not interpolate variables or invoke a shell. A version may explicitly name a shell as its command. Arguments must be non-empty, single-line strings, with at most 32 arguments of 256 characters each. Treat command arguments as public metadata; reference secret names instead of pasting credentials into them. Values are supplied as environment variables to the task only.

Select an exact target and choose **Review task**. The review shows the command, timeout, networking, image ID, artifact digest, target, agent, environment and secret versions. It expires after 15 minutes. A changed target fence, environment policy or secret version requires another review. Only the actor who made the review can request it, and each review can create at most one run. Network retries reuse the existing idempotency key.

Acknowledge the task's external effects, then request the run. Approval is required by default. Setting `requiresApproval: false` queues immediately only when the environment does not require approval. A different actor with `approve` permission must inspect and acknowledge an approval request. `write` permits definition creation, publishing, reviewing, requesting and cancellation; it does not grant approval. Project and environment restrictions apply together to all these operations and reads.

## Execution and recovery

Update the API, gateway, workflow worker and Go agent together. Agents advertise `runbooks-v1`; an older agent cannot claim a runbook or its cleanup assignment. The review requires an active registered agent but does not prove that the agent is online or upgraded. Unclaimed assignments eventually fail with `AGENT_UNAVAILABLE`.

Tasks can use local Docker, local Docker blue/green targets, or the existing Linux Docker-over-SSH transport. The agent's local target allowlist still controls the Docker host and network. `network: none` is the default. `network: target` requires an operator-configured `hook_network`; its isolation and reachable services are the operator's responsibility. No task can choose a Docker socket, mount, published port or arbitrary host network in its process.

The task container has one CPU, 256 MiB memory, a 64-process limit, dropped capabilities, no privilege escalation, an init process and a read-only filesystem. The image's `/bin/timeout` bounds execution if the agent dies. Docker logging is disabled and Keel stores fixed phase and result codes only. Secret values travel over the current mTLS lease and Docker stdin. Revocation blocks further delivery but cannot recall values already delivered.

A run holds the same project/environment lock as deployments, including while awaiting approval or reconciling an interrupted attempt. A durable journal prevents replay of the same attempt. Cancellation and lease loss lead to cleanup of that attempt's task container. An interrupted run receives a new cleanup fence and ends with `RECONCILED`; Keel does not rerun the command automatically. Recovery still requires the original host and state directory. There is no force-unlock or reassignment to another host.

Task cleanup leaves application containers and blue/green routes alone. A task may still change a database or another reachable service. Cancellation cannot undo those changes, and a failed or interrupted result does not prove that nothing happened. Inspect the effects before creating another reviewed run. Exactly-once external effects are not guaranteed.

Runbook success is `RUNBOOK_SUCCEEDED`, not an application health check. Other task results include `RUNBOOK_FAILED` and `RUNBOOK_TIMEOUT`. Claiming a runbook conservatively clears the target's verified-release projection because the task may affect application state. Success leaves that projection unknown. A subsequent successful deployment can verify it again. Runs have their own catalogue and history and never qualify as release promotion evidence.

## CLI and API

```sh
npm run keel -- runbook validate runbook.yaml
npm run keel -- runbook create --project PROJECT_ID --environment ENVIRONMENT_ID --name 'Cache check' --slug cache-check
npm run keel -- runbook publish RUNBOOK_ID --artifact ARTIFACT_ID --process runbook.yaml --revision 0
npm run keel -- list runbook-versions --runbook RUNBOOK_ID
npm run keel -- runbook review --version VERSION_ID --target TARGET_ID
npm run keel -- runbook request REVIEW_ID --acknowledge-external-effects
# Use a different approving actor's token after reviewing the run.
npm run keel -- runbook approve RUN_ID --acknowledge-external-effects
npm run keel -- list runbook-runs --project PROJECT_ID --environment ENVIRONMENT_ID
npm run keel -- runbook secret-bindings RUN_ID
npm run keel -- runbook cancel RUN_ID
```

Publishing uses the definition's current `revision`; each publication increments it. `--version` on the review command is the immutable version UUID returned by publishing, not its display number. Use `--idempotency-key` for retryable writes. `runbook reject RUN_ID` rejects a pending approval.

| Method | Path                                | Purpose                                                         |
| ------ | ----------------------------------- | --------------------------------------------------------------- |
| POST   | `/runbooks/validate`                | Validate `{process}` without publishing                         |
| POST   | `/runbooks`                         | Create `{project_id, environment_id, name, slug, description?}` |
| POST   | `/runbooks/:id/versions`            | Publish `{artifact_id, process, expected_revision}`             |
| POST   | `/runbook-plans`                    | Review `{runbook_version_id, target_id}`                        |
| POST   | `/runbook-plans/:id/request`        | Request with `{acknowledge_external_effects: true}`             |
| POST   | `/runbook-runs/:id/approve`         | Approve with the same acknowledgement                           |
| POST   | `/runbook-runs/:id/reject`          | Reject with `{}`                                                |
| POST   | `/runbook-runs/:id/cancel`          | Cancel with `{}`                                                |
| GET    | `/runbook-runs/:id/secret-bindings` | Read pinned secret metadata                                     |

Paths use the `/api/v1` prefix. Catalogue, version and run reads use `/resources/runbooks`, `/resources/runbook-versions` and `/resources/runbook-runs`, including individual `/:id` lookups. Each supports pagination, search and project/environment filters; versions also accept `runbook_id`, and runs accept `runbook_version_id` and `status`.

Runbook definitions, versions, reviews, runs and audit records are retained in PostgreSQL. Existing backups include their artifacts and encrypted secret versions. Restore quarantines agents and invalidates the target state, so old reviews must be repeated before new work. Active or reconciling tasks block a clean backup. No retention expiry or deletion flow is provided yet.

Typed inputs, multi-step workflows, schedules, automatic retries, task-output logs and runbook webhook notifications are not implemented. Existing deployment webhook rules do not receive runbook events. Inspect the run history and audit log for results.
