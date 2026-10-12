# Promotion and application rollback

Keel promotes an immutable release by deploying the same release ID, artifact digest and process snapshot into another environment. It does not rebuild or copy the source CI artifact again.

## Promotion policy

Local setup gives production a staging prerequisite as well as its existing separate-approver requirement. Migration 006 adds that prerequisite to existing workspaces that have both environments. Existing deployment requests keep their original admission; the migration does not cancel or reclassify them.

An approver can edit a prerequisite in **Environments → Edit policy**. A prerequisite applies across all projects in that environment. It must belong to the same workspace, and chains cannot contain cycles. Select **No prerequisite** to remove it. Policy changes are audited and use a revision check to prevent one editor from overwriting another's change. Operators and readers cannot change policy.

A release satisfies the prerequisite only after that exact release has a successful deployment with a verified agent attempt in the required environment. A queued request, manual approval, failed health check, or different release using the same artifact is insufficient. The evidence is historical verification, not a statement that the prerequisite target is still healthy now.

The deployment dialog checks promotion eligibility before enabling its request button. The API independently checks again when accepting the request. Admission records the policy revision, prerequisite deployment and approval requirement. Later policy edits affect new requests; they do not change requests already awaiting approval or execution. Cancel an existing request and submit it again if it needs the new policy. Production approval still requires a different actor.

```sh
npm run keel -- deployment promotion --release <release-uuid> --environment <environment-uuid>
npm run keel -- deployment request --release <release-uuid> --environment <environment-uuid>
```

The promotion check reports policy eligibility only. Artifact availability and target execution have their own checks; an eligible response is not a reservation or a promise that a deployment can succeed.

## Plan a rollback

Open **Deployments → Plan rollback** on the latest finished deployment that actually reached the target. If an interrupted attempt is still reconciling, finish its cleanup first. The planner lists up to 50 different releases previously verified on that same target and environment, newest first. Failed or unexecuted releases are excluded.

Choose a release and select **Review rollback plan**. Keel verifies the retained bytes, checks the current promotion policy, and requires the saved process to select the same single Docker target with an active agent. The review shows the release, digest, target, HTTP path, approval requirement and expiry. Creating a plan records an audit event but does not reserve the target or start deployment.

Review application compatibility before selecting **Request rollback**. Docker recreate causes downtime. Redeploying application code does not restore databases, undo migrations, remove data written by a newer version, or reverse external effects. Keel cannot determine that compatibility for you; the request records your acknowledgement of this boundary.

A plan can be requested once, within 15 minutes. At request time Keel rechecks retained bytes, target history, environment locks, promotion policy and the policy revision. New target work or changed policy requires a new review. The request follows the ordinary approval flow, with immutable links to its plan and prerequisite evidence. Expiry limits when a request can be created; it does not expire a request already awaiting approval.

The workflow is pinned to the reviewed target and fence. It will not silently redirect the rollback to another matching target. The private agent then runs the retained process with a fresh lease and fence, and only HTTP verification can mark it successful. Cancellation, lease expiry and certificate recovery use the same cleanup rules as other deployments.

```sh
npm run keel -- deployment rollback-candidates <latest-deployment-uuid>
npm run keel -- rollback plan --from <latest-deployment-uuid> --candidate <earlier-verified-deployment-uuid>
npm run keel -- rollback request <reviewed-plan-uuid> --acknowledge-data-not-restored
```

Use a stable `--idempotency-key` when retrying a request after a lost response. Reusing a plan with a different key will not create another deployment. If the rollback itself fails, complete any required cleanup before planning again.

## Current boundaries

This stage supports explicit rollback of one Docker target using the recreate strategy. There is no automatic rollback, coordinated service rollback, database restore, promotion freshness window, deployment freeze, or compatibility inference. A retained release can also be requested normally; that still uses the current promotion and approval policy, but does not carry a rollback plan.

The test suite covers policy permissions and cycles, exact-release evidence, immutable admission, expired/stale plans, organisation isolation, retained-byte loss and target substitution. The live execution test uses PostgreSQL, Temporal, mutual TLS, the Go agent and Docker to recover an interrupted deployment, restore a retained release, then promote that release to a second target after separate approval. Provider responses remain fixtures; tests do not connect a live GitHub repository.
