# Self-hosting Keel

This package runs one Keel installation on a Docker Compose host. PostgreSQL stores both Keel records and Temporal history in separate databases. Local artifact bytes live in a separate volume. It is a single-host deployment: losing the host interrupts service until you restore it.

Use a dedicated host with Docker Engine, Docker Compose v2, Node.js 22.12 or later, npm, OpenSSL and tar. The host must reach your artifact providers. Agents need outbound access to the gateway. The API, workers and gateway run as an unprivileged user with a read-only root filesystem, dropped capabilities and no Docker socket. Deployment agents run on deployment hosts; see [agent setup](deployment-agents.md).

## Install

From a checkout of the release you intend to run:

```sh
npm ci
npm run self-host -- init --directory /srv/keel/main --project keel-main --hostname keel.example.com --bind 0.0.0.0 --image-tag 0.1.0
npm run self-host -- build --directory /srv/keel/main
npm run self-host -- up --directory /srv/keel/main
npm run self-host -- status --directory /srv/keel/main
npm run self-host -- verify --directory /srv/keel/main
```

Choose a directory your administrator account can write. Initialization refuses an existing directory. Omit `--bind` for loopback-only access. HTTPS defaults to port 8443 and the agent gateway to 8444; `--https-port` and `--agent-port` change these. Allow only intended clients through the host firewall. PostgreSQL and Temporal have no published ports and use an internal Compose network.

Initialization creates independent database passwords, three API tokens, two encryption keys, a private certificate authority and server/client certificates. The directory and its `secrets` and `tls` subdirectories are private to the host account. Mounted secret files are readable by the container user; keep their parent directories private. Docker administrators can read these files and the database. Protect host access accordingly.

Trust `tls/ca.crt` on operator machines and agents. The certificate covers the configured hostname and localhost. Test HTTPS without bypassing verification:

```sh
curl --cacert /srv/keel/main/tls/ca.crt https://keel.example.com:8443/health
```

Open the same HTTPS address in your browser. Read `secrets/operator_token` to sign in as an operator. Give `secrets/approver_token` to the approver and `secrets/secret_manager_token` to the secret manager through your secure credential channel. They are distinct identities and permissions. Do not paste them into shell command arguments, logs or tickets. This remains a token-based, single-workspace installation; invitations, SSO, expiring tokens and a token-management screen are not implemented.

The generated `tls/agent.crt` and `tls/agent.key` are for one initial deployment host. Register that certificate's fingerprint, copy its identity and the CA to that host, and configure the gateway address. Issue a separate client certificate for each additional agent; never share an agent key between hosts. Follow [agent setup](deployment-agents.md) for registration, host targets and certificate replacement.

## Keys, certificates and database access

The API receives provider and deployment-secret encryption keys. The artifact worker receives only the provider key; the gateway receives only the deployment-secret key. The workflow worker receives neither. API tokens are stored as hashes in PostgreSQL. Backup encryption uses an additional key kept outside the installation.

The one-shot provisioning command uses PostgreSQL's administrator account. Migrations use `keel_owner`; long-running Keel services use `keel_runtime`, which has data access but cannot create tables, alter schemas or connect to Temporal's databases. Temporal owns its own databases. Application queries and composite foreign keys enforce organisation boundaries; PostgreSQL row-level security is not enabled.

Generated server and agent certificates expire after 365 days; the CA expires after ten years. Track expiry with your monitoring system. Renew server certificates with the same hostname and server-auth usage before expiry, cleanly stop the installation, replace `tls/server.crt` and `tls/server.key`, and restart. Preserve the private parent-directory permissions and container-readable server-key mode. Agent renewal uses the certificate replacement flow. Keep the CA private key offline when it is not needed for signing. Automatic certificate renewal and encryption-master-key rotation are not implemented. Do not replace encryption keys without migrating their encrypted records.

## Operate and upgrade

`status` reports every service and exits unsuccessfully if any required service is absent, stopped or unhealthy. API checks include a verified HTTPS request; worker checks include recent queue progress and database connectivity, with Temporal connectivity checked for the deployment worker. Gateway checks cover its listener, certificate validity and database connectivity. Use external HTTPS and agent probes as well; these local checks do not prove host reachability or a complete deployment. Compose restarts exited services, but an unhealthy status alone does not restart a running container.

`verify` reads every retained artifact and checks its digest, decrypts all saved provider credentials and deployment-secret versions, and checks the migration version. It reports counts without printing plaintext credentials. It can be expensive on a large installation.

Use the Compose project name to identify logs, for example `docker logs keel-main-api-1`. Logs rotate locally at three 10 MiB files per long-running service. Forward them to your monitoring system if you need longer retention. Alert on failed health checks, disk capacity, certificate expiry, failed backups and deployment reconciliation.

Before upgrading, finish or cancel queued deployments and resolve reconciliation. Run `stop`, then create and verify an encrypted backup as described in [recovery](recovery.md). `stop` closes admission, checks for active work, then stops workers, Temporal and PostgreSQL. If work prevents stopping, it restarts admission and fails. Requests awaiting approval may remain in a backup; active or queued execution may not.

Retain the old checkout, installation configuration and exact images before building a new release. Use a new image tag in `installation.json`, build from the matching checkout, then run `up`. Startup provisions roles, applies Keel and Temporal migrations, creates the namespace if needed and waits for service health. It refuses to migrate while application services are running. Afterward run `status` and `verify`. Test each upgrade against a restored copy first. Migrations are forward-only; recovering the old version requires the pre-upgrade backup and old images, not a binary downgrade against the new schema.

An interrupted startup may leave some services running. Inspect logs and fix the cause before retrying. If application services started, use `stop` first. Commands acquire `.operation-lock`; after a killed CLI process, remove that directory only once you have confirmed no operation is still running.

The package pins Node, PostgreSQL and Temporal versions. Follow Temporal's [self-hosted deployment guidance](https://docs.temporal.io/self-hosted-guide/deployment) when planning version changes. Temporal runs the server image with explicitly managed PostgreSQL schemas, not the development server. This package does not include high availability, managed backups, Kubernetes manifests or an external object-store backup workflow.
