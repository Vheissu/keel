# Deployment secrets

Each secret belongs to one workspace, project and environment. A release process names the secrets it needs. When a deployment request is accepted, Keel pins their current versions and records those bindings separately from the immutable release.

Production and staging can use the same secret name with different values. There is no fallback to another environment or project. Secret management requires `read` and `manage_secrets`; ordinary operator and approver tokens cannot change values. Operators can deploy applications that use secrets, subject to the environment's approval policy. Treat deployment permission as permission to run code that can access that environment's referenced credentials. Token permissions remain workspace-wide in this local identity model.

## Local setup

Run `npm run setup` after upgrading. It applies migration 007 and creates a separate `KEEL_SECRET_MANAGER_TOKEN` and `KEEL_DEPLOYMENT_SECRET_KEY` when absent. Existing operator and approver permissions stay unchanged.

The API and agent gateway need the same deployment secret key. It is a base64-encoded 32-byte key, separate from the provider credential key. Back it up securely alongside the database backup; losing it makes retained secret versions unusable. Secret creation and rotation fail when the key is absent. Metadata reads and revocation still work. Automatic master-key rotation and external vault integration are not implemented.

Local commands load the shared `.env` for evaluation. In a private installation, provide the deployment key only to the API and gateway. Artifact import workers, Temporal workflows and deployment agents do not need it. Keep remote API access behind HTTPS; the agent gateway requires mutual TLS.

## Add a value and reference it

Connect with the secret-manager token and open **Secrets**. Select a project and environment, then **Add secret**. Names use uppercase letters, digits and underscores, starting with a letter. Values must be nonempty, single-line UTF-8 strings of at most 8 KiB, without NUL, CR or LF characters. The password field clears on submission, and no API or UI read returns the value.

Add a reference to the release's process:

```yaml
spec:
  environments:
    staging:
      strategy: recreate
      targetSelector:
        labels:
          tier: staging
      secrets:
        APP_PASSWORD:
          secret: DATABASE_PASSWORD
      verify:
        http:
          path: /health
```

This fragment belongs inside a complete deployment process with its artifact definition. `APP_PASSWORD` is the container environment variable; `DATABASE_PASSWORD` is the secret name in the selected project and environment. A process may reference up to 32 variables per environment. Inline values, cross-scope paths and unsupported properties are rejected.

The deployment dialog checks whether references exist and shows the versions currently available. Admission checks again and pins versions in the same transaction as the deployment request. **Deployments → Secret versions** shows the accepted bindings, including whether they have since been revoked. Missing or disabled secrets block admission.

## Rotate and revoke

**Rotate** creates a new encrypted version. Pending requests keep their existing versions; new requests use the new version. This prevents a rotation from silently changing an already approved request. Both rotation and revocation require the metadata revision last read, so simultaneous editors cannot overwrite each other.

**Revoke** disables the secret and revokes every retained version. Subsequent agent retrieval fails, including for pending requests pinned to an older version. Adding a new version makes the secret available for new requests without restoring access to revoked versions. Encrypted historical records remain in PostgreSQL; there is no version garbage collector yet.

Revocation cannot recall bytes an agent has already received or remove credentials from a running container. Rotate or revoke the credential at its source and replace affected containers when responding to a leak. A secret retrieval failure is reported as `SECRET_UNAVAILABLE` before container replacement, leaving the previous application untouched by that preflight failure. The target projection remains unknown until a deployment verifies it again.

Rollback review uses the current secret versions required by the retained release. It does not restore old credential values. The plan lists those versions; rotation or revocation before the rollback request requires a new review. After the request is accepted, its bindings follow the same pinning rules as any deployment.

## CLI

Use a token with `manage_secrets`. Pipe the exact value from a protected source on stdin; do not add a trailing newline or place the value in command arguments or shell history. The CLI returns metadata only.

```sh
npm run keel -- secret list --project <project-uuid> --environment <environment-uuid>

npm run keel -- secret create \
  --project <project-uuid> --environment <environment-uuid> \
  --name DATABASE_PASSWORD --value-stdin < /secure/path/value

npm run keel -- secret rotate <secret-uuid> \
  --revision 1 --value-stdin < /secure/path/new-value

npm run keel -- secret revoke <secret-uuid> --revision 2
npm run keel -- deployment secret-bindings <deployment-uuid>
```

Pass a stable `--idempotency-key` when retrying after an uncertain response. Secret write fingerprints use a keyed HMAC, preventing a database-only attacker from testing guesses against a plain hash of the request body.

## Agent delivery and logging

Rebuild and restart the Go agent for this stage. It advertises `deployment-secrets-v1` when polling. An older agent can still execute releases without secrets and perform cleanup, but cannot claim a new deployment with secret bindings. Unclaimed work eventually reports `AGENT_UNAVAILABLE`.

Only the registered agent with a current lease for that deployment can call the gateway's `/agent/v1/secrets` endpoint. Wrong agents, expired leases, cancelled work, retired certificates and cleanup-only assignments cannot retrieve values. The response disables caching. Decryption authenticates the workspace, project, environment, secret identity and version using AES-256-GCM authenticated data. Values never enter job contracts or Temporal history.

After verifying the target and artifact, the agent passes environment values to Docker through an anonymous stdin pipe using `--env-file /dev/stdin`. There are no plaintext temporary files, secret command arguments or secret additions to the agent process's environment. Container variables follow Docker's [environment-file syntax](https://docs.docker.com/reference/cli/docker/container/run/#env); the single-line constraint prevents additional variables being injected through line breaks.

Keel accepts fixed progress phases and result codes, not free-text agent output. Docker output, HTTP response bodies and application logs are not uploaded. API secret errors are generic, and audit/idempotency records contain metadata only. This is an exclusion policy rather than a general-purpose log masking engine: application logs remain the application's responsibility. The application, the Docker daemon and administrators with access to that host can read container environment values. Secret files, multiline values and external vault references are later work.
