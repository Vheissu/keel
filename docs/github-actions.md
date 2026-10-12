# GitHub Actions artifact ingestion

Keel imports completed build outputs. Your workflow stays in GitHub Actions; Keel does not check out source or run its build steps.

## Connect a workflow

1. Run `npm run setup`, then `npm run dev`. Setup creates a credential encryption key if one is missing; the dev command starts the API, web app and import worker.
2. Create a Keel project. Open **Integrations → Connect GitHub Actions**.
3. Enter the repository as `owner/repository`, its numeric workflow ID, the allowed branch, and the exact artifact name published by the workflow. `gh workflow list --repo owner/repository` shows workflow IDs.
4. Supply a fine-grained GitHub token restricted to that repository with **Actions: read** permission. Supply a random webhook secret of at least 32 characters. Keel verifies repository/workflow access before saving the encrypted connection.
5. In GitHub repository webhook settings, use the URL shown under **Webhook setup**, content type `application/json`, the same secret, and the **Workflow runs** event. The API needs a publicly reachable HTTPS address for GitHub deliveries.

Publish the named artifact with a current `actions/upload-artifact` action that supplies SHA-256 metadata. A successful run on the configured branch queues one import. Manual imports work without a public webhook endpoint: choose **Import run**, enter the run ID and current attempt number, then refresh to inspect its progress.

The worker accepts `push`, `workflow_dispatch`, `schedule` and `release` events when all configured repository, workflow and branch checks match. Pull-request events, fork sources, failed runs, expired artifacts and missing provider digests are rejected. Re-running a workflow increments its attempt number. If another attempt starts before import completes, import the new successful attempt.

Keel retains the original ZIP archive, verifies its digest, and records the source commit/run. It does not extract the archive. Maximum size is 25 MiB. After an import reaches **Retained**, open Artifacts or Releases to create an immutable release. GitHub artifact expiry cannot remove the retained copy.

## CLI

Connection policy goes in a JSON file; credentials come from environment variables rather than command-line arguments:

```json
{
  "name": "Application builds",
  "project_id": "<Keel project UUID>",
  "repository": "owner/repository",
  "workflow_id": "123456",
  "branch": "main",
  "artifact_name": "application"
}
```

Set `KEEL_TOKEN`, `KEEL_GITHUB_TOKEN` and `KEEL_GITHUB_WEBHOOK_SECRET`, then run:

```sh
npm run keel -- integration connect --config github.json
npm run keel -- integration list
npm run keel -- integration pipelines <connection-uuid>
npm run keel -- artifact import --connection <connection-uuid> --run <run-id> --attempt 1
npm run keel -- import retry <failed-import-uuid>
npm run keel -- integration disable <connection-uuid>
npm run keel -- integration enable <connection-uuid>
npm run keel -- integration rotate <connection-uuid>
```

Rotation reads the new credentials from the same environment variables. Update the GitHub webhook secret at the same time. An expired or revoked provider token produces a visible import error; rotate it and retry. Disabling a connection blocks new imports and prevents in-flight imports from being committed under its old configuration.

## Operations

The API and import worker need the same database, credential key and artifact storage configuration. For compiled processes, run `npm start` and `npm run worker:artifacts` separately. The worker claims one import at a time; multiple worker processes can share the queue. Network/rate-limit/storage failures retry up to five times with persisted backoff. Failed imports remain visible for an explicit retry.

Keep `KEEL_CREDENTIAL_KEY` secure and recoverable. Losing it makes stored connection credentials unusable. Changing it without re-encrypting connections is not a supported key rotation procedure. The browser clears credential form values when dialogs close and does not persist them in browser storage.

The test suite exercises the GitHub HTTP contract with fixtures. A real repository connection still requires your token, workflow and webhook configuration. GitHub App installation, OAuth, automatic releases, pipeline triggering, CI cancellation and deployments are outside this stage.

References: [GitHub artifact API](https://docs.github.com/en/rest/actions/artifacts), [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs), and [webhook signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
