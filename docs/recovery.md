# Backup and operational recovery

A usable Keel backup contains PostgreSQL (including Temporal history), retained artifact bytes, installation configuration, TLS identities and both application encryption keys. This package takes a cold backup of its local volumes. It does not back up deployment hosts, application databases or external S3 buckets.

## Make a backup

Generate a dedicated 32-byte backup key once, outside the installation directory. Keep an offline copy in a separate secure location. Losing it makes the backup unusable.

```sh
npm run self-host -- keygen --key-file /secure/keel-backup.key
npm run self-host -- stop --directory /srv/keel/main
npm run self-host -- backup --directory /srv/keel/main --output /backups/keel/2026-10-13 --key-file /secure/keel-backup.key
npm run self-host -- verify-backup --backup /backups/keel/2026-10-13 --key-file /secure/keel-backup.key
npm run self-host -- up --directory /srv/keel/main
```

Choose a new output directory each time. The command requires a successful clean stop and refuses while any installation service is running. Configuration, database and artifacts are streamed into separate AES-256-GCM archives; the encrypted manifest records their checksums and exact application, PostgreSQL and Temporal image IDs. A failed backup removes its partial output. Services remain stopped until you run `up`.

Keep the backup directory on independent storage. Save the exact images with `docker image save` and retain the matching source checkout and lockfile. Tags can move; restore compares image IDs. Also retain the pinned Temporal admin-tools and BusyBox helper images for an offline recovery. A backup must be tested by restoring it; successful archive authentication alone does not prove database or application recovery.

## Restore to a fresh installation

Fence the old control-plane host before restoring: stop it or block its network access to agents and operators. Confirm it cannot restart. A backup may predate deployments made on the old host; two control planes must never command the same agents.

Load the saved container images and use the matching source checkout. Choose a new directory and Compose project name. Restore refuses to overwrite any existing project containers or data volumes.

```sh
npm run self-host -- restore --backup /backups/keel/2026-10-13 --directory /srv/keel/restored --project keel-restored --key-file /secure/keel-backup.key
npm run self-host -- up --directory /srv/keel/restored
npm run self-host -- status --directory /srv/keel/restored
npm run self-host -- verify --directory /srv/keel/restored
```

Restore authenticates the manifest and all three archives before extraction, verifies exact image identities, restores into fresh volumes, and starts only PostgreSQL. It then checks migrations, retained bytes and encrypted values. Before allowing startup, it revokes every agent, marks every target's current release as unknown and appends an `installation.restored` audit event. Fences are preserved. It stops PostgreSQL again and leaves all services stopped.

Configuration retains the old hostname and ports. Update the new installation's `installation.json` if ports or bind address must change. A changed hostname also needs a matching server certificate. The backup is a physical PostgreSQL snapshot: use the recorded PostgreSQL image and a compatible host architecture. Cross-version PostgreSQL upgrades are separate maintenance work.

If restore fails after extraction begins, `recovery-pending` blocks startup. Preserve the failed destination for diagnosis; do not remove that marker to bypass verification. Correct missing images or keys, then retry into another fresh directory and project. Remove failed test resources only after identifying their exact project and volumes. Never run a blanket volume prune as a recovery step.

## Reconnect agents deliberately

A restored database cannot attest to what is currently running on deployment hosts. Keep restored agents revoked until you have fenced the old control plane and inspected each host. Stop the old agent process, retain its local state and configure the restored gateway. Issue a fresh client certificate and use the same-host certificate replacement flow in [agent recovery](deployment-agents.md). That flow preserves target fences and retires the old fingerprint.

Reconcile any host-side workload that was created after the backup with the host owner. Keel does not provide automatic cleanup of work missing from the restored database, force-unlock or host reassignment. Do not erase agent state to bypass a higher local fence. If the host has advanced beyond the restored fence, keep it revoked and recover a newer backup or follow a reviewed manual recovery procedure. Once the host is safe, reactivate the agent and deploy a retained release to establish new verification evidence. Review requests awaiting approval before approving them.

Verify the artifact download, release history, approval queue, secrets metadata and recovery audit event. Provider credentials must still be valid at the provider; decrypting a saved credential cannot establish that. Application database recovery remains the application owner's responsibility. Keel's release rollback does not restore application data.

## Recovery drills

`npm run test:self-host` builds and exercises a disposable packaged installation, including encrypted backup and fresh-volume recovery. It requires Docker and available ports, and removes only its own test projects and volumes. The ordinary test suite also checks archive authentication failures, key handling, retained-byte corruption and agent quarantine.

Run a drill with your own off-host backup and image archive before relying on this procedure. Record the backup age, restore duration, verification counts and any manual agent reconciliation; those measurements determine your actual recovery point and recovery time.
