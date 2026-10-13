# Deployment lifecycle hooks

An environment can declare one `preDeploy` hook and one `postDeploy` hook in its retained release process. Hooks run in separate containers from the same pinned image as the application. Local Docker recreate, SSH Docker recreate and local Docker blue/green support them.

Use hooks for short, repeatable release tasks. A failed hook fails the deployment. Keel does not retry hooks, run failure hooks or allow an error to be ignored.

## Declare a hook

See [the complete example](../examples/hooks-process.yaml). This fragment belongs inside a process environment:

```yaml
secrets:
  APP_DATABASE_URL:
    secret: DATABASE_URL
hooks:
  preDeploy:
    command: [/app/bin/migrate, --compatible]
    timeoutSeconds: 60
    secrets: [APP_DATABASE_URL]
    network: target
  postDeploy:
    command: [/app/bin/check-release]
    timeoutSeconds: 15
```

Commands are argument arrays: 1–32 nonempty strings, each at most 256 characters, without control characters. There is no implicit shell or variable interpolation. A release may explicitly invoke an image's shell, such as `[/bin/sh, -c, 'test -n "$APP_DATABASE_URL"']`; it cannot invoke a host shell. Commands and arguments are retained in the release and visible to readers, so never put credentials in them.

`timeoutSeconds` is required and must be an integer from 1 to 120. The image must provide a BusyBox/GNU-compatible `/bin/timeout` supporting `-s KILL`, plus the declared executable. Missing runtime components fail the hook. Keel overrides the image entrypoint with that timeout executable and enables Docker’s init process for signal handling and child cleanup. Its timer continues if the agent crashes or loses its SSH connection. The agent also limits the entire create/start/wait sequence to the declared duration; cleanup has a separate bounded allowance. The Docker command limit and overall deployment lease can end execution sooner.

The image must support running as UID/GID `65532:65532` with a read-only root filesystem. Each hook has 256 MiB memory with no additional swap, one CPU, 64 processes, all Linux capabilities dropped and `no-new-privileges`. A 16 MiB writable `/tmp` is mounted with `noexec,nosuid`. Keel adds no host mounts or published ports, and disables container restarts and Docker logging. Image contents, baked-in environment variables and image-declared volumes still belong to the image's trust boundary; use a dedicated Docker host for trusted workloads. These flags are not a sandbox for hostile images.

## Secrets and networking

Hooks receive no Keel secrets by default. Each hook's `secrets` array selects variable names from that environment's `secrets` mapping, with at most 32 unique names. Unknown variables and inline secret values are rejected. Selected values use the deployment's pinned versions; rollback uses the versions reviewed for its new request. The application still receives all environment secret bindings.

Secret values pass through anonymous stdin to Docker. They do not appear in commands, state files, progress events or result codes. Hook stdout/stderr is discarded and Docker logging is disabled; this stage has no hook-log viewer. The image and Docker administrators can still read supplied environment values. Network access also lets a hook transmit them. See [secret management and revocation](deployment-secrets.md).

Networking defaults to `none`. To reach a database or service, explicitly set `network: target` and configure `hook_network` on that target in the private agent's JSON:

```json
{
  "host_port": 8088,
  "container_port": 8080,
  "hook_network": "keel-release-tasks"
}
```

The operator must create and secure that Docker network on the execution host. For SSH targets, it lives on the remote host. Releases cannot choose a network name, host networking or another container's namespace. Missing agent configuration fails before any hook or application replacement. A configured but nonexistent network fails Docker hook creation. Network reachability and egress restrictions are the operator's responsibility. This setting applies only to hook containers.

## Ordering and failure behavior

The agent verifies the retained artifact and image and retrieves pinned secrets before running `preDeploy`. It then deploys and HTTP-verifies the application, runs `postDeploy`, and verifies the application again before reporting success. Blue/green switches traffic to the verified candidate before the post-deploy hook, so that candidate can serve requests while the hook runs.

| Failure point                               | Application outcome after confirmed cleanup                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Pre-deploy hook or its timeout              | Existing application remains untouched.                                                                        |
| Post-deploy hook or its timeout, recreate   | New application is removed. The previous recreate container is already gone.                                   |
| Post-deploy hook or its timeout, blue/green | Candidate is removed and the previous route is restored, or the proxy returns 503 if no previous route exists. |
| Cancellation or lease loss                  | Hooks are stopped and removed; application cleanup follows how far execution reached.                          |
| Cleanup cannot be confirmed                 | Reconciliation remains outstanding and the target stays locked.                                                |

Fixed result codes are `PRE_HOOK_FAILED`, `PRE_HOOK_TIMEOUT`, `POST_HOOK_FAILED`, `POST_HOOK_TIMEOUT`, `HOOK_NETWORK_UNAVAILABLE` and `HOOK_STATE_FAILED`. Targets shows recovery guidance, with `pre_hook` and `post_hook` progress phases. Cancellation and lease recovery keep their existing result codes. A recovered timer exit may be reported as reconciliation rather than a hook timeout. Failed deployments do not assert that a preserved application or restored route is currently healthy; target state remains unknown until a new deployment verifies it.

## Crash recovery and repeated deployments

The agent writes a durable lifecycle journal before starting hooks and before replacing the application. Preserve `lifecycle-<target-id>.json` in its original state directory across restarts and certificate replacement, including when using SSH targets. Recovery receives a higher fence and performs cleanup only. It never reruns a hook from the interrupted attempt. Invalid journals fail closed and require operator investigation; deleting a journal is not an unlock procedure.

This does not provide exactly-once external effects. A hook can change a database and then fail, time out or lose its agent before completion is recorded. Cleanup cannot reverse those changes. Write hooks to tolerate interruption and repetition, and inspect partial effects before submitting a new request. A manual redeployment or application rollback runs the retained release's hooks again. Check compatibility with current data before approving it.

## Upgrade

Apply migrations and rebuild the gateway and agent. Hook-capable agents advertise `deployment-hooks-v1`; older agents cannot claim hook deployments or their cleanup assignments. Keep an upgraded agent on the original host with its original state directory for recovery. Unclaimed deployments eventually report `AGENT_UNAVAILABLE`.
