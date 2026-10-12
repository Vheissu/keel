# Artifact storage

The API and artifact worker share an `ArtifactStore`. Local storage remains the default. Set `ARTIFACT_STORE=s3` to use an existing S3-compatible bucket. Both adapters verify SHA-256 on every read.

## Local S3 evaluation

```sh
npm run infra:storage
npm run test:s3
```

Compose starts RustFS on `127.0.0.1:59000` with its console at `127.0.0.1:59001`. Sign in with the local-only credentials from Compose (`keel-local` / `keel-local-storage-only`) and create a bucket named `keel-artifacts`.

Set these values in `.env`:

```dotenv
ARTIFACT_STORE=s3
S3_BUCKET=keel-artifacts
S3_ENDPOINT=http://127.0.0.1:59000
S3_FORCE_PATH_STYLE=true
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=keel-local
AWS_SECRET_ACCESS_KEY=keel-local-storage-only
```

Restart the API and worker together after configuration changes. For AWS S3, omit `S3_ENDPOINT` and use the AWS SDK credential chain, including workload credentials where available. Remote custom endpoints require HTTPS. Buckets must exist before publishing.

## Move retained local artifacts

Pause API writes and stop import workers before switching drivers. Configure the destination S3 settings above, then run:

```sh
npm run storage:copy-to-s3
```

The command reads every distinct blob referenced by artifact metadata or a Bitbucket submission, verifies the local bytes, writes them conditionally to S3, and verifies the retained copy. It does not change database records or delete local files. Re-running it is safe. Do not restart with the S3 driver until the command reports every referenced blob verified. Keep the local files until you have a tested backup of S3 and PostgreSQL.

## Retention behaviour

Keys are `<organisation UUID>/<sha256>`. Uploads use `If-None-Match: *`; an existing object is read and verified instead of overwritten. A corrupt existing object causes an error and is not silently repaired. Pending and failed Bitbucket submissions also retain private blobs. Failed imports can leave unreferenced blobs. No garbage collector or automatic retention expiry runs in this stage.

The adapter does not configure bucket permissions, versioning, object lock, replication or lifecycle rules. Its runtime credentials need object put/get access to the configured bucket. Avoid delete permissions and lifecycle rules that remove retained release artifacts. Backups must cover database metadata, blobs and the credential encryption key.

The current API/import limit is 25 MiB. Downloads pass through the authenticated API and are verified there; signed client downloads and resumable transfers are not implemented.

References: [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) and [RustFS container setup](https://docs.rustfs.com/en/installation/container/docker).
