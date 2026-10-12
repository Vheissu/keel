# Bitbucket Pipelines publishing

Connect a Bitbucket Cloud repository, then publish an existing build output from a pipeline step. Keel checks the pipeline, commit and publishing step through Bitbucket's API. It holds the uploaded bytes privately until the complete pipeline succeeds, then creates a retained artifact that can be used in a release.

This integration uses a publishing step. The [documented Pipelines API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/) exposes pipeline and step status but does not document a direct pipeline-artifact download endpoint. Keel does not use Bitbucket's internal browser API. It also does not launch builds, trigger pipelines or deploy anything in this stage.

## Connect the repository

Run `npm run setup` to apply migrations and configure the credential key. Start Keel with `npm run dev`, create a project, then open **Integrations → Connect Bitbucket Pipelines**.

Supply the repository as `workspace/repository`, an allowed branch and an exact pipeline selector. For a definition under `pipelines.branches.main`, use `branches:main`. Use `default:` for the default pipeline or `custom:release` for a custom pipeline named `release`. A wildcard selector such as `branches:release/*` still needs one exact allowed branch. Pull-request and tag targets are rejected.

Create a [repository access token](https://support.atlassian.com/bitbucket-cloud/docs/using-access-tokens/) with **Repository: read** and **Pipelines: read** permissions. Keel uses this bearer token to verify repository identity and CI status. API tokens authenticated with an Atlassian email, app passwords, OAuth setup and Bitbucket Data Center are not supported by this adapter.

Generate a separate publishing secret:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Enter it in the connection form and save the same value as a secured `KEEL_PUBLISH_SECRET` variable in Bitbucket. Use a different secret for each connection. The repository access token stays in Keel; the publishing step only needs the publishing secret. Both secrets are encrypted at rest and are never returned by the API.

## Add the publishing step

Copy [scripts/publish-bitbucket.mjs](../scripts/publish-bitbucket.mjs) into the repository that runs the pipeline. It uses Node 22 or later and has no dependencies. Set `KEEL_URL` to the externally reachable HTTPS address of the Keel API and `KEEL_CONNECTION_ID` to the connection UUID shown under **Publishing setup**.

Run this after the build and tests, while the pipeline step is still running:

```yaml
- step:
    name: Publish release artifact
    image: node:24
    script:
      - node scripts/publish-bitbucket.mjs dist/application.tar.gz
```

The file must already exist in that step. Use Bitbucket's shared artifacts to pass it from an earlier build step, or run the publisher at the end of the build step itself. The publisher reads `BITBUCKET_PIPELINE_UUID`, `BITBUCKET_STEP_UUID` and `BITBUCKET_COMMIT` from the pipeline environment, computes SHA-256 and submits the original bytes. Maximum size is 25 MiB. Keel does not extract archives or impose a file format.

A `202` response means the upload was accepted for verification. It does not mean the pipeline succeeded or the artifact is ready for deployment. The import worker polls the complete pipeline every 30 seconds while it remains queued or running. Waiting does not consume the five transient-failure retries. A run that is still incomplete after 24 hours fails the import.

Pipeline and publishing-step success are both required. A failed test in a later step keeps the uploaded artifact out of releases. Once retained, the artifact has version `bb-<pipeline UUID without braces>` and records the source repository UUID, pipeline, step, commit, selector and original status. Creating a release remains an explicit operator action.

## Trust and retries

The publishing secret is a bearer credential scoped to artifact submission for one connection. It cannot read workspace data, create releases, approve deployments or administer integrations. Restrict it to trusted builds and protect changes to the publishing script and pipeline configuration. A secured repository variable is masked in logs; masking alone does not stop a malicious build from using it.

Keel verifies the referenced run through Bitbucket, but the checksum comes from the authenticated publisher. This is not signed build attestation or proof that arbitrary uploaded bytes were produced by the referenced commit. Provenance records `digest_source: authenticated-publisher` so it cannot be mistaken for a provider-supplied digest.

Duplicate submissions of the same pipeline, step, commit and digest return the original import. Different bytes or a different publishing step for that pipeline are rejected. New uploads require the pipeline and step to be running; they cannot be attached retrospectively to a completed successful run. An exact duplicate remains safe to retry after completion. To replace an artifact, start a new pipeline with a new UUID.

The worker verifies retained bytes again before publishing artifact metadata. Disabling a connection blocks uploads and prevents an in-flight worker from committing under the old connection revision. Rotating credentials invalidates the old publishing secret; update the secured variable in Bitbucket at the same time. A failed import can be retried from the UI or CLI after its underlying problem is resolved.

## CLI

Connection configuration:

```json
{
  "name": "Release builds",
  "project_id": "<Keel project UUID>",
  "repository": "workspace/repository",
  "workflow_id": "branches:main",
  "branch": "main",
  "artifact_name": "application"
}
```

For administration, set `KEEL_TOKEN`, `KEEL_BITBUCKET_TOKEN` and `KEEL_PUBLISH_SECRET`:

```sh
npm run keel -- integration connect --provider bitbucket --config bitbucket.json
npm run keel -- integration rotate <connection-uuid> --provider bitbucket
npm run keel -- integration disable <connection-uuid>
npm run keel -- import retry <failed-import-uuid>
```

When using a checkout of Keel inside a pipeline, this command invokes the same standalone publisher:

```sh
npm run keel -- artifact publish-bitbucket dist/application.tar.gz --connection <connection-uuid>
```

Publishing requires `KEEL_PUBLISH_SECRET`, `KEEL_URL` and the Bitbucket pipeline environment variables. It does not require an operator's `KEEL_TOKEN`.

Tests use Bitbucket HTTP fixtures and real PostgreSQL/storage. A live repository still needs its access token, secured publishing variable and pipeline configuration.
