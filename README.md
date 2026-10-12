# Keel

Build anywhere. Deploy everywhere.

Keel is a continuous delivery application for artifacts built by your existing CI. This repository contains the control-plane foundation and GitHub Actions artifact ingestion stage from [PLAN.md](PLAN.md).

You can create projects, publish files with SHA-256 verification, create immutable releases, request deployments to staging or production, approve them from a separate identity, and inspect the audit trail. The Aurelia interface uses navy, sea teal, off-white, and small animated boats for loading states. Motion follows the operating system’s reduced-motion preference.

Deployment execution is not implemented yet. Requests remain queued; Keel does not run scripts or report a successful deployment. GitHub artifact imports and S3 storage are available. Bitbucket ingestion, Temporal deployment workers, agents and rollback are the next stages.

## Run locally

Use Node.js 22.12+ and Docker with Compose. The database uses port 55439, the API 4040, and the web app 5173. The dev command also starts the artifact import worker.

```sh
npm ci
npm run setup
npm run dev
```

Open **http://127.0.0.1:5173**. Copy `KEEL_OPERATOR_TOKEN` from the generated `.env` file into the connection form. Setup creates a local workspace, staging and production environments, and two identities. It does not add sample projects or deployments.

Use `KEEL_APPROVER_TOKEN` from `.env` in another browser session to approve or reject a production request. The operator can publish and request deployments but cannot approve. The approver cannot publish or request deployments. Even an identity with both permissions cannot approve its own request.

Tokens are stored as SHA-256 hashes in PostgreSQL. The browser keeps its token in memory; reloading the page requires reconnecting. `npm run setup` preserves your data and can be rerun. Changing a bootstrap token in `.env` and rerunning setup revokes the previous token for that local identity.

The default local store keeps artifacts in `.data/artifacts/<organisation>/<sha256>`. [S3 setup and migration](docs/storage.md) are available when you want a shared artifact store. Keep this directory with the database when backing up local state. `npm run infra:down` stops PostgreSQL without removing its volume.

## Import from GitHub Actions

Open **Integrations** to connect a project to a GitHub repository, workflow, branch and artifact name. The UI accepts a repository-scoped token with Actions read access and a random webhook secret. Setup generates `KEEL_CREDENTIAL_KEY` for encrypting these credentials; retain it with your backups.

A signed successful-workflow webhook or manual import request queues the import worker. It verifies the run and archive checksum, then retains the ZIP with its source provenance. Create a release from that artifact in the Releases screen. Imports do not create deployments automatically.

See [GitHub setup and CLI examples](docs/github-actions.md).

## Publish from a build

The initial CLI runs from this checkout. Set `KEEL_TOKEN` to the operator token and use project and artifact UUIDs from `status --json` or the API.

```sh
export KEEL_URL=http://127.0.0.1:4040
export KEEL_TOKEN=<your-operator-token>

npm run keel -- artifact publish ./app.tar.gz \
  --project <project-uuid> --name application --version 1.0.0 \
  --idempotency-key build-123-artifact

npm run keel -- validate examples/process.yaml
npm run keel -- release create \
  --project <project-uuid> --artifact <artifact-uuid> --version 1.0.0 \
  --process examples/process.yaml --idempotency-key build-123-release

npm run keel -- status --json
```

The CLI outputs JSON and exits nonzero on failure. Reuse an idempotency key only for retries of the same request. A release fixes the process and artifact digest; deploying it to another environment never creates a new artifact.

## Verify

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run format:check
```

Run `npm run infra:storage` followed by `npm run test:s3` for the real S3-compatible storage tests. CI runs these alongside the default suite.

Integration and browser tests use real PostgreSQL in temporary schemas, with separate organisations and artifact directories. They do not mutate the local workspace. Override `TEST_DATABASE_URL` to use a separate PostgreSQL database. Tests need permission to create and drop schemas.

The suite covers organisation isolation, immutable records, checksums, idempotent retries, concurrent environment locks, approval policy, cancelled requests, browser publishing, keyboard navigation, mobile overflow, reduced motion, and axe accessibility checks. The GitHub Actions workflow runs the same checks against PostgreSQL 17.

Run `npm run format` after editing source. ESLint requires braces around control flow, blank lines between methods and logical blocks, and explicit branches instead of nested ternaries. Prettier handles indentation and line wrapping. `npm run format:check` checks both in CI.

To serve a compiled local build:

```sh
npm run build
NODE_ENV=production npm start
# In another terminal:
npm run worker:artifacts
```

Open **http://127.0.0.1:4040**. This uses the same local configuration; it is not a supported production deployment package.

See [the API contract](docs/api.md) and [implementation status](docs/implementation.md) for boundaries and next work.
