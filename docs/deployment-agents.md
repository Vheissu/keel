# Private Docker and SSH deployment agents

Keel can deploy a retained `docker image save` archive through a private Go agent, either on its local Docker daemon or on a Linux Docker host reached over SSH. Execution supports one Docker target per deployment, recreate on local or SSH targets, and blue/green on local targets. Both strategies require an HTTP 200 health check. The release pins the image configuration ID as well as the archive SHA-256. No registry is needed after publishing.

The agent opens outbound HTTPS connections to a separate mutual-TLS gateway. It does not listen for inbound control connections. Application ports are published on the Docker host's loopback interface. Run the gateway where the private host can reach it, with a certificate for that hostname; the local instructions below use localhost.

## Start the local services

```sh
npm run db:migrate
npm run infra:execution
npm run build
npm run agent:build
sh scripts/setup-agent-tls.sh
```

The certificate script creates a local CA, server certificate and agent certificate in `.data/agent-tls`, with private file permissions and a 30-day lifetime. It refuses to replace an existing directory. Keep the CA private key off the agent host. These certificates are for local evaluation; use your own CA and certificate renewal process for a private installation.

Start these alongside the existing API and web application:

```sh
npm run worker:deployments
```

```sh
AGENT_TLS_CERT=.data/agent-tls/server.crt \
AGENT_TLS_KEY=.data/agent-tls/server.key \
AGENT_TLS_CA=.data/agent-tls/ca.crt \
npm run gateway:agents
```

The gateway defaults to `127.0.0.1:4041`. `AGENT_HOST` and `AGENT_PORT` override it. The worker defaults to Temporal at `127.0.0.1:7233`, namespace `default`, queue `keel-deployments`; override these with `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE`. This worker currently connects to a local/private Temporal service without Temporal Cloud authentication. Compose persists the development server's SQLite database and exposes its UI on localhost:8233. It is not a production Temporal deployment.

## Register the host and target

Open **Targets → Register agent**. Enter the SHA-256 certificate fingerprint printed by the certificate script. The UI accepts colon-separated or plain lowercase fingerprints. The gateway requires both a trusted client certificate and an active registration for its exact fingerprint. Proxy identity headers are ignored.

Create a project if needed, then select **Add target**. Bind the target to the project, staging or production, and the registered agent. Labels must match the release process; the example uses `app=web,tier=staging`. More than one matching target fails the deployment rather than choosing one arbitrarily.

Copy `examples/agent.json` outside source control. Replace the certificate, key, CA and state directory paths with absolute paths. Replace the example target UUID with the ID displayed in Targets. Choose unprivileged container and host ports. On Docker Desktop for macOS, find the local socket with:

```sh
docker context inspect --format '{{.Endpoints.docker.Host}}'
```

Set `docker_socket` to the absolute socket path without `unix://`. For a remote Linux host, use the SSH configuration below; direct TCP Docker endpoints are not supported. Run one identity on one host, under one OS account, against a dedicated local Docker daemon. Do not share a client certificate across hosts or accounts. The state-directory lock and host-wide target locks prevent overlapping local agent processes; Docker itself does not offer a distributed fencing transaction.

```sh
agents/deployment-agent/deployment-agent /absolute/path/agent.json
```

Keep the agent configuration and keys readable only by its OS account. Docker socket access grants control over that Docker daemon. Use a dedicated host for workloads you trust; container flags do not turn a shared daemon into a hostile-code sandbox.

## Deploy to a Linux host over SSH

Select **Docker over SSH** when registering the target. API clients set `capability` to `ssh-docker-recreate-v1`; omission preserves the existing local Docker default. The release uses the same pinned image, archive, HTTP path and recreate strategy. Promotion, approved rollback and scoped deployment secrets use the existing release flow. This transport deploys containers; host shell commands, file-copy deployments and systemd service management are not implemented.

The private agent needs OpenSSH's `ssh` executable. The remote Linux host needs an SSH server, Docker Engine at `/var/run/docker.sock`, the Docker CLI and the matching Keel helper binary. Install the helper from this checkout for the remote host's architecture:

```sh
# Use arm64 instead of amd64 for an ARM Linux host.
sh scripts/build-agent.sh linux amd64 ssh-helper
```

Install `agents/deployment-agent/ssh-helper` on the remote host as `/usr/local/bin/keel-agent`, executable by the deployment account. It runs only when SSH invokes it and needs no gateway credentials or inbound Keel service. Create a persistent directory such as `/var/lib/keel-targets`, mode `0700`, owned by that account. The account needs access to Docker's socket. Use a dedicated account and host: Docker access permits control of the daemon.

Copy [examples/agent-ssh.json](../examples/agent-ssh.json) outside source control and replace the target ID, gateway identity and SSH connection settings. Protect the SSH private key and configuration with account-only file permissions. Use a dedicated, noninteractive key; interactive passphrases and an SSH authentication agent are not supported. Install its public key in the remote account's `authorized_keys`. Disable forwarding for that key with the OpenSSH `restrict` option.

Populate the configured `known_hosts_file` with host keys verified through your host provisioning process or another trusted channel. For a nonstandard port, use OpenSSH's `[hostname]:port` form. Keel requires a matching trusted host key and never accepts new or changed keys automatically. It ignores user/system SSH configuration, disables forwarding and uses only the configured identity. These options follow the [OpenSSH configuration reference](https://man.openbsd.org/ssh_config).

Connection fields stay on the private agent. The API cannot supply an SSH address, key, command or executable. Paths must be absolute and contain only letters, digits, underscores, dots, slashes and hyphens. Each remote target must retain the same host, Docker daemon, account, helper state directory and target ID throughout recovery. Do not repoint an existing target or delete its lock/fence files. Allocate a new target ID for a different host. Multiple targets on the same host must have distinct published ports, including targets managed by different agent configurations.

The helper holds a host-side target lock for the complete SSH session and durably records the highest fence. Each Docker child inherits the lock, so killing the helper cannot release it while that command is still running. Older fences and simultaneous sessions are refused before Docker runs. Docker commands have a 30-second limit; a helper session has an 11-minute limit. Cancellation closes the SSH transport and cleanup reconnects under the same remote lock. A lost connection, unavailable host, changed host key or unconfirmed cleanup leaves the deployment locked for reconciliation. Restore access to the original host; the agent must confirm cleanup before another deployment can begin.

Artifacts and secret values travel through encrypted SSH stdin. The helper executes Docker directly, and HTTP verification runs against the remote host's loopback port. Secret values are never command arguments or temporary files, but Docker administrators can read the container environment. Remote command output and SSH diagnostics are not published in deployment logs. `DOCKER_FAILED` can also indicate a remote transport or helper failure; inspect the agent configuration and SSH server locally when troubleshooting.

An upgraded agent advertises `ssh-docker-recreate-v1`. Older agents cannot claim either deployment or cleanup work for an SSH target. Registering an SSH target against an older agent therefore leaves work queued until the normal queue timeout.

## Publish and deploy an existing image

Build the image in your existing CI, then export exactly one image:

```sh
docker image inspect --format '{{.Id}}' your-image:1.0.0
docker image save --output application.tar your-image:1.0.0
npm run keel -- artifact publish application.tar \
  --project <project-uuid> --name application --version 1.0.0
```

The existing 25 MiB artifact limit applies. Publish the raw, uncompressed Docker archive through the API, CLI or Bitbucket publishing step. For a GitHub Actions artifact ZIP, set `spec.artifact.dockerArchivePath` to its exact entry name, such as `application.tar`. Omit this field for raw archives. See [GitHub Docker packaging](github-actions.md#package-a-docker-image-for-deployment).

Keel retains and verifies the original ZIP digest. The agent reads the selected entry into memory and verifies its pinned image configuration before loading Docker. It never extracts ZIP paths to disk. Both the retained ZIP and the total declared uncompressed contents must fit within 25 MiB; the selected entry is also bounded while reading and checked for CRC errors. Archives with more than 1,000 entries, unsafe or duplicate names, links or encrypted entries are rejected. Paths use slash-separated letters, digits, underscores, hyphens and dots, with no leading dot in a segment.

Copy `examples/docker-process.yaml` and replace `dockerImageId` with the full `sha256:...` image ID. Create an immutable release using that process and the retained artifact. Request a deployment in the UI. Production still requires a different person's approval; YAML cannot lower the environment's policy.

The application must run as UID/GID 65532, listen on the configured unprivileged port, and work with a read-only root filesystem. Keel fixes memory at 256 MiB, CPU at one core and the process limit at 64. It drops Linux capabilities, enables `no-new-privileges`, supplies no host mounts, and does not override the image's entrypoint or command. Named [deployment secrets](deployment-secrets.md) can be delivered as container environment variables. Docker-declared image volumes may still create anonymous volumes; cleanup removes them. There are no migration hooks or shell steps.

The agent verifies archive bytes, checks that its single image configuration matches the release, loads the image, replaces the owned target container and checks HTTP status plus container identity. Redirects are not followed. Recreate causes downtime; a failed deployment can leave the target empty. The same retained release can be redeployed through the normal request and approval path. [Promotion prerequisites and reviewed rollback plans](promotion-and-rollback.md) also apply to agent deployments.

## Cancellation and recovery

Temporal retries scheduling transactions and tracks a workflow per deployment. Transactional outbox delivery uses a stable workflow ID; a crash between workflow creation and delivery acknowledgement does not create another execution.

The agent receives a 45-second lease, renewed every ten seconds, with a ten-minute execution deadline. Credentials are random, hashed in PostgreSQL, and scoped to the agent, attempt and target fence. Every new assignment increments the target's fence. Download and result endpoints reject stale credentials. Agent progress uses fixed step names and results use fixed codes; Docker output and application logs are not sent to the control plane.

Rebuild agents when enabling deployment secrets. Agents advertise `deployment-secrets-v1`; older agents cannot claim deployments with secret bindings. The gateway needs the same `KEEL_DEPLOYMENT_SECRET_KEY` as the API, and both services need restarting if setup added the key after they started. Secret values are fetched under the current lease and passed through Docker stdin. They are absent from job contracts, command arguments and agent state files. A `SECRET_UNAVAILABLE` preflight failure occurs before container replacement and leaves the existing application untouched. Revocation blocks later retrieval but cannot recall credentials already delivered to containers.

Cancellation of an active deployment becomes **Cancelling · cleanup pending**. The environment stays locked until the agent confirms cleanup. Success cannot override cancellation. If the lease expires, the state becomes **Reconciliation required** and the target stays locked. When the same agent returns, it receives a new cleanup-only lease, removes the owned container and records the interrupted deployment as failed or cancelled. It cannot resume the old attempt as a success. Create a new deployment to retry after cleanup. The agent tolerates brief heartbeat failures. If it stops or loses its lease mid-deployment, it removes the container and reports the attempt as failed; only an operator cancellation is recorded as cancelled.

Drain prevents new assignments while allowing active work and cleanup. Revocation immediately denies further gateway requests, including existing leases, and permanently retires that certificate. There is no force-unlock or target reassignment endpoint.

### Replace or recover an agent certificate

1. Drain the agent for routine renewal, or revoke it if the certificate should no longer authenticate. Stop the old process on the Docker host. For active work, wait for completion or for the workflow worker to move the expired lease into reconciliation; replacement is blocked while an attempt is running or reconciling.
2. Issue a new client certificate from a CA trusted by the gateway. Keep the existing agent identity, Docker host, OS account, daemon, state directory and target allowlist. This procedure does not support moving a target to another host.
3. Open **Targets → Replace certificate** on the drained or revoked agent. Enter the new SHA-256 fingerprint and confirm that the old process is stopped and the host is unchanged. The old fingerprint can never be registered again, including under another agent.
4. Install the new certificate and key in the local agent configuration, then start the agent. Replacement leaves it **draining**. Interrupted attempts receive cleanup-only leases with higher fences; their environment and target locks stay in place until cleanup is confirmed.
5. Refresh Targets. Once cleanup finishes, select **Resume**. Resume is rejected while reconciliation remains outstanding. Request a new deployment to retry the release.

The operator confirmation records the host requirement in the audit trail; the control plane cannot remotely prove that a certificate was installed on the original host. If that host or daemon is lost, leave the target locked and investigate manually. Registering a replacement host does not reconcile the original one.

For automation, `POST /api/v1/agents/:id/certificate` requires write permission, an idempotency key and `{ "certificate_fingerprint": "<64 lowercase hex characters>", "same_host_agent_stopped": true }`. Certificate issuance stays with your CA; Keel registers fingerprints and does not hold agent private keys.

### Read deployment diagnostics

Targets shows the last reported step and its timestamp: downloading, loading image, replacing container, verifying HTTP or cleaning up. These reports are advisory and require the current fenced lease. The result remains authoritative. Failure guidance points to the artifact contract, local Docker setup or HTTP verification as appropriate; reconciliation includes the same-host recovery instructions. Raw Docker output, application logs and arbitrary agent messages are not accepted.

**Verified release** records the last successful deployment verification. Starting another attempt clears that projection to **Unknown**. It is not continuous uptime monitoring. The overview environment matrix remains the latest deployment request, with its status. Targets and attempts show the latest 200 records and refresh on demand.

## Verification

```sh
npm run test:agent
npm run infra:execution
npm run test:execution
```

The execution suite uses real PostgreSQL, Temporal, mutual TLS, the compiled Go agent and Docker. It rejects unauthenticated certificates, restarts the workflow worker, retries outbox delivery and imports a GitHub-format ZIP through the provider fixture and deploys it after provider expiry and removal of the original image and archive. It then redeploys the retained release and checks the target's increased fence and container restrictions. A forced agent crash during health verification leaves the deployment locked; replacing its revoked certificate and restarting on the same host obtains a cleanup lease, removes the interrupted container and records failure. Test containers, certificates and database schemas are isolated and removed afterward.

See the [Temporal TypeScript guide](https://docs.temporal.io/develop/typescript) and [Docker resource controls](https://docs.docker.com/engine/containers/resource_constraints/) for the underlying worker and runtime APIs.

The execution suite also starts a disposable Linux SSH server with its own Docker daemon. It checks trusted-host deployment, rejection of an untrusted host, remote secret delivery, crash reconciliation, cancellation cleanup and a successful retry. The fixture requires permission to run a privileged Docker container; this is test infrastructure only.

## Blue/green on a local Docker target

Register a new target with **Local Docker · blue/green**, or API capability `docker-blue-green-v1`. Copy [agent-blue-green.json](../examples/agent-blue-green.json) and replace the paths and target UUID. The three host ports must be distinct and unprivileged: `host_port` is the agent's loopback HTTP proxy, while `blue_port` and `green_port` are Docker's loopback backend ports. Keep this configuration, the target ID and the persistent state directory together for the life of the target. Run the agent as a supervised service. Your ingress can terminate TLS and forward requests to `host_port`.

Set the release environment's `strategy` to `blue-green`; [blue-green-process.yaml](../examples/blue-green-process.yaml) shows both staging and production. The pinned `dockerImageId`, optional `dockerArchivePath`, secret references, selector and HTTP check work as they do for recreate. The agent starts a candidate in the inactive slot, verifies its HTTP response and container identity, confirms the lease, then durably switches the proxy route. A final HTTP check goes through the proxy before success is reported. The former active container stays running until the next deployment needs that slot.

| Registered target capability | Recreate | Blue/green |
| ---------------------------- | -------- | ---------- |
| `docker-recreate-v1`         | Yes      | No         |
| `ssh-docker-recreate-v1`     | Yes      | No         |
| `docker-blue-green-v1`       | No       | Yes        |

Incompatible combinations fail with `INCOMPATIBLE_TARGET_STRATEGY` before assignment. Rolling remains a declaration only and fails with `UNSUPPORTED_PROCESS`. An agent must advertise `docker-blue-green-v1` to claim either a deployment or recovery job. Upgrading the control plane alone does not enable this strategy on older agents.

Before switching traffic, failure or cancellation removes the candidate and leaves the active route in place. After a switch, recovery durably restores the previous route before deleting the interrupted attempt's container. If this was the first deployment, there is no previous route and the proxy returns HTTP 503. Cleanup reports `previous_route_restored` or `no_previous_route` separately from the deployment's failure code. The Targets screen shows that outcome. Restoring a route does not assert that the old application is healthy now, so the control plane leaves the target's release state **Unknown** until a new deployment succeeds.

A crash or an expired lease requires a cleanup-only assignment with a higher fence. The environment stays locked until recovery is confirmed. A failed cleanup, corrupt route file or unavailable Docker daemon leaves reconciliation outstanding. A lost success response does not trigger local cleanup: if the server committed success, the new route stays active; otherwise lease expiry starts recovery. Keep the original state directory when restarting or replacing a certificate. Do not delete, copy back an old version of, or hand-edit `route-<target-id>.json` to unlock a target.

This is a single-host HTTP strategy. The proxy runs inside the agent, so restarting or stopping the agent interrupts application traffic; container restart policy remains `no`. Gateway outages alone do not stop the proxy. Two application containers must fit on the host and tolerate running concurrently against shared data. Requests already in progress keep their selected backend across a route switch, but there is no connection-drain guarantee when a later deployment removes that slot. Arbitrary TCP routing, SSH blue/green, multi-host traffic control, automatic rollback after a completed deployment and database recovery are not implemented.

## Lifecycle hooks

Releases may declare bounded pre- and post-deploy container hooks for every supported target strategy. Rebuild the agent and gateway to enable `deployment-hooks-v1`. Hooks require `/bin/timeout` in the retained image, receive only explicitly selected secrets and have no network access by default. Preserve lifecycle state alongside fences and blue/green route files. See [hook contracts, limits and recovery](lifecycle-hooks.md) before enabling them.

## Runbook tasks

Agents advertising `runbooks-v1` can execute [reviewed runbooks](runbooks.md) through the same target allowlist, mTLS leases and secret delivery. Tasks with typed inputs also require `runbook-inputs-v1`. The agent validates input names and transport bounds, then supplies literal `KEEL_INPUT_*` variables through Docker stdin alongside the selected secrets. Input values are reviewed metadata and do not change the fixed command. Poll responses remain capped at 64 KiB.

A task owns its bounded container only. Cleanup preserves application containers and blue/green routes; external task effects still require operator assessment. Upgrade the controller, gateway, worker and agent together before requesting tasks.
