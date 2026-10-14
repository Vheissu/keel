#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  parseProcess,
  parseRunbook,
  resolveRunbookInputs,
} from '../../../packages/deployment-schema/src/index.js';

const options = {
  allowPositionals: true,
  options: {
    endpoint: { type: 'string' },
    delivery: { type: 'string' },
    deployment: { type: 'string' },
    provider: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    search: { type: 'string' },
    state: { type: 'string' },
    status: { type: 'string' },
    project: { type: 'string' },
    name: { type: 'string' },
    version: { type: 'string' },
    artifact: { type: 'string' },
    target: { type: 'string' },
    slug: { type: 'string' },
    runbook: { type: 'string' },
    schedule: { type: 'string' },
    cron: { type: 'string' },
    'time-zone': { type: 'string' },
    inputs: { type: 'string' },
    'acknowledge-external-effects': { type: 'boolean' },
    release: { type: 'string' },
    environment: { type: 'string' },
    from: { type: 'string' },
    candidate: { type: 'string' },
    revision: { type: 'string' },
    'value-stdin': { type: 'boolean' },
    'acknowledge-data-not-restored': { type: 'boolean' },
    connection: { type: 'string' },
    agent: { type: 'string' },
    run: { type: 'string' },
    attempt: { type: 'string' },
    config: { type: 'string' },
    process: { type: 'string' },
    'idempotency-key': { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  },
} as const;

function fail(message: string, json: boolean) {
  console.error(json ? JSON.stringify({ error: message }) : message);
  process.exitCode = 1;
}

function parseCommandLine() {
  try {
    return parseArgs(options);
  } catch (error) {
    // Report unknown or malformed flags without a stack trace.
    fail((error as Error).message, process.argv.includes('--json'));
    process.exit();
  }
}

async function readInputs(path: string): Promise<unknown> {
  if ((await stat(path)).size > 32768) {
    throw new Error('Runbook input files must not exceed 32 KiB.');
  }

  const bytes = await readFile(path);

  if (bytes.length > 32768) {
    throw new Error('Runbook input files must not exceed 32 KiB.');
  }

  return JSON.parse(bytes.toString('utf8'));
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

const { values, positionals } = parseCommandLine();

const help = `Keel · publish existing build outputs and create immutable releases

  npm run keel -- artifact publish <file> --project <uuid> --name application --version 1.0.0
  npm run keel -- release create --project <uuid> --artifact <uuid> --version 1.0.0 --process process.yaml
  npm run keel -- artifact publish-bitbucket <file> --connection <uuid>
  npm run keel -- integration connect --provider bitbucket --config bitbucket.json
  npm run keel -- integration rotate <connection-uuid> --provider bitbucket
  npm run keel -- integration list
  npm run keel -- integration connect --config github.json
  npm run keel -- integration rotate <connection-uuid>
  npm run keel -- integration enable|disable|pipelines <connection-uuid>
  npm run keel -- artifact import --connection <uuid> --run <run-id> --attempt 1
  npm run keel -- import retry <import-uuid>
  npm run keel -- deployment promotion --release <uuid> --environment <uuid>
  npm run keel -- deployment request --release <uuid> --environment <uuid>
  npm run keel -- deployment rollback-candidates <deployment-uuid> [--cursor <cursor>]
  npm run keel -- rollback plan --from <deployment-uuid> --candidate <prior-deployment-uuid>
  npm run keel -- rollback request <plan-uuid> --acknowledge-data-not-restored
  npm run keel -- secret list --project <uuid> --environment <uuid>
  npm run keel -- secret create --project <uuid> --environment <uuid> --name DATABASE_PASSWORD --value-stdin
  npm run keel -- secret rotate <secret-uuid> --revision <number> --value-stdin
  npm run keel -- secret revoke <secret-uuid> --revision <number>
  npm run keel -- deployment secret-bindings <deployment-uuid>
  npm run keel -- runbook validate <runbook.yaml> [--inputs inputs.json]
  npm run keel -- runbook create --project <uuid> --environment <uuid> --name <name> --slug <slug>
  npm run keel -- runbook publish <runbook-uuid> --artifact <uuid> --process runbook.yaml --revision <number>
  npm run keel -- runbook review --version <version-uuid> --target <uuid> [--inputs inputs.json]
  npm run keel -- runbook request <review-uuid> --acknowledge-external-effects
  npm run keel -- runbook schedule <review-uuid> --name <name> --cron '0 3 * * *' --time-zone UTC --acknowledge-external-effects
  npm run keel -- runbook stop|resume <schedule-uuid> --revision <number>
  npm run keel -- runbook approve <run-uuid> --acknowledge-external-effects
  npm run keel -- runbook reject|cancel|secret-bindings <run-uuid>
  npm run keel -- validate <process.yaml>
  npm run keel -- list <resource> [--limit 25] [--cursor <cursor>] [--search <text>]
  npm run keel -- notification create --config webhook.json
  npm run keel -- notification enable|disable <endpoint-uuid> --revision <number>
  npm run keel -- notification retry <delivery-uuid>
  npm run keel -- status --json

Set KEEL_URL (default http://127.0.0.1:4040) and KEEL_TOKEN.
Connection creation and rotation use KEEL_GITHUB_TOKEN and KEEL_GITHUB_WEBHOOK_SECRET.
Bitbucket uses KEEL_BITBUCKET_TOKEN and KEEL_PUBLISH_SECRET; publishing needs only KEEL_PUBLISH_SECRET.
For retryable CI steps, pass a stable --idempotency-key (8–128 characters).
List resources: projects, environments, artifacts, releases, deployments, audit, agents, targets, attempts, connections, imports, secrets, notification-endpoints, notification-deliveries, notification-attempts, runbooks, runbook-versions, runbook-runs, runbook-schedules.
Use --project, --environment, --connection, --agent, --state or --status where the resource supports that filter.
Runbook filters: --runbook for versions and schedules, --schedule for runs.
Notification filters: --endpoint, --deployment (a deployment or runbook run ID), --delivery, --status.
Creation reads KEEL_NOTIFICATION_SECRET. Add "work_kinds": ["deployment", "runbook"] to the config for runbook events.
Results are JSON. Review a rollback plan before requesting it. Approvals remain available in the UI and API.
Secret writes require manage_secrets permission. Pipe the exact single-line value on stdin, with no trailing newline.
Secret values are never returned. Revocation cannot recall credentials already delivered to a container.
`;

function required(key: keyof typeof values): string {
  const value = values[key];

  if (typeof value !== 'string' || !value) {
    throw new Error(`--${key} is required.`);
  }

  return value;
}

async function request(path: string, body?: unknown) {
  const base = new URL(process.env.KEEL_URL || 'http://127.0.0.1:4040');

  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  ) {
    throw new Error('Use HTTPS for remote Keel servers.');
  }

  const token = process.env.KEEL_TOKEN;

  if (!token) {
    throw new Error('Set KEEL_TOKEN to a scoped API token.');
  }

  const binary = Buffer.isBuffer(body);
  let requestBody: Uint8Array<ArrayBuffer> | string | undefined;

  if (body !== undefined) {
    requestBody = binary ? new Uint8Array(body) : JSON.stringify(body);
  }

  const response = await fetch(new URL(`/api/v1${path}`, base), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined
        ? {
            'Content-Type': binary ? 'application/octet-stream' : 'application/json',
            'Idempotency-Key': values['idempotency-key'] || randomUUID(),
          }
        : {}),
    },
    body: requestBody,
  });

  // Proxies can return HTML or empty bodies, so keep the status when the body is not JSON.
  const text = await response.text();
  let result;

  try {
    result = JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
    }
  }

  if (!response.ok) {
    throw new Error(
      `${result?.error?.code || response.status}: ${result?.error?.message || 'Request failed.'}`,
    );
  }

  return result;
}

async function readSecret() {
  if (!values['value-stdin'] || process.stdin.isTTY) {
    throw new Error(
      'Pipe a secret value on stdin and pass --value-stdin. Values are not accepted as arguments.',
    );
  }

  const chunks: Buffer[] = [];
  let length = 0;

  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);

      length += bytes.length;

      if (length > 8192) {
        bytes.fill(0);
        throw new Error('Secret values must fit within 8192 UTF-8 bytes.');
      }

      chunks.push(bytes);
    }

    const bytes = Buffer.concat(chunks);

    try {
      const value = bytes.toString('utf8');

      if (!value || /[\x00\r\n]/.test(value) || !Buffer.from(value, 'utf8').equals(bytes)) {
        throw new Error('Use a non-empty UTF-8 value without NUL or newline characters.');
      }

      return value;
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

try {
  const [command, subcommand, file] = positionals;

  if (values.help || !command) {
    console.log(help);
  } else if (command === 'validate') {
    if (!subcommand) {
      throw new Error('Provide a deployment process file.');
    }

    print({ valid: true, process: parseProcess(await readFile(subcommand, 'utf8')) });
  } else if (command === 'list') {
    if (!subcommand || !/^[a-z-]+$/.test(subcommand)) {
      throw new Error('Provide a resource name, such as projects, releases or deployments.');
    }

    const query = new URLSearchParams();

    for (const [flag, parameter] of [
      ['runbook', 'runbook_id'],
      ['schedule', 'runbook_schedule_id'],
      ['endpoint', 'endpoint_id'],
      ['delivery', 'delivery_id'],
      ['deployment', 'deployment_id'],
      ['limit', 'limit'],
      ['cursor', 'cursor'],
      ['search', 'q'],
      ['project', 'project_id'],
      ['environment', 'environment_id'],
      ['connection', 'connection_id'],
      ['agent', 'agent_id'],
      ['state', 'state'],
      ['status', 'status'],
    ] as const) {
      if (values[flag]) {
        query.set(parameter, values[flag]!);
      }
    }

    print(await request(`/resources/${subcommand}?${query}`));
  } else if (command === 'notification' && subcommand === 'create') {
    const config = JSON.parse(await readFile(required('config'), 'utf8'));

    print(
      await request('/notifications/endpoints', {
        ...config,
        signing_secret: process.env.KEEL_NOTIFICATION_SECRET,
      }),
    );
  } else if (command === 'notification' && ['enable', 'disable', 'retry'].includes(subcommand)) {
    if (!file) {
      throw new Error('Provide a destination or delivery UUID.');
    }

    print(
      await request(
        subcommand === 'retry'
          ? `/notifications/deliveries/${encodeURIComponent(file)}/retry`
          : `/notifications/endpoints/${encodeURIComponent(file)}/state`,
        subcommand === 'retry'
          ? {}
          : { enabled: subcommand === 'enable', expected_revision: Number(required('revision')) },
      ),
    );
  } else if (command === 'runbook') {
    if (subcommand === 'validate') {
      if (!file) {
        throw new Error('Provide a runbook process file.');
      }

      const process = parseRunbook(await readFile(file, 'utf8'));

      print({
        valid: true,
        process,
        ...(values.inputs
          ? {
              input_values: resolveRunbookInputs(
                process.spec.inputs,
                await readInputs(values.inputs),
              ),
            }
          : {}),
      });
    } else if (subcommand === 'create') {
      print(
        await request('/runbooks', {
          project_id: required('project'),
          environment_id: required('environment'),
          name: required('name'),
          slug: required('slug'),
        }),
      );
    } else if (subcommand === 'publish') {
      if (!file) {
        throw new Error('Provide a runbook UUID.');
      }

      print(
        await request(`/runbooks/${encodeURIComponent(file)}/versions`, {
          artifact_id: required('artifact'),
          expected_revision: Number(required('revision')),
          process: parseRunbook(await readFile(required('process'), 'utf8')),
        }),
      );
    } else if (subcommand === 'review') {
      print(
        await request('/runbook-plans', {
          runbook_version_id: required('version'),
          target_id: required('target'),
          inputs: values.inputs ? await readInputs(values.inputs) : {},
        }),
      );
    } else if (subcommand === 'schedule') {
      if (!file) {
        throw new Error('Provide the review UUID.');
      }

      if (!values['acknowledge-external-effects']) {
        throw new Error('Review the command and pass --acknowledge-external-effects.');
      }

      print(
        await request('/runbook-schedules', {
          runbook_plan_id: file,
          name: required('name'),
          cron: required('cron'),
          time_zone: required('time-zone'),
          acknowledge_external_effects: true,
        }),
      );
    } else if (subcommand === 'stop' || subcommand === 'resume') {
      if (!file) {
        throw new Error('Provide the schedule UUID.');
      }

      print(
        await request(`/runbook-schedules/${encodeURIComponent(file)}/state`, {
          enabled: subcommand === 'resume',
          expected_revision: Number(required('revision')),
        }),
      );
    } else if (['request', 'approve', 'reject', 'cancel', 'secret-bindings'].includes(subcommand)) {
      if (!file) {
        throw new Error('Provide the review or run UUID.');
      }

      const acknowledge = ['request', 'approve'].includes(subcommand);

      if (acknowledge && !values['acknowledge-external-effects']) {
        throw new Error('Review the command and pass --acknowledge-external-effects.');
      }

      const body = acknowledge ? { acknowledge_external_effects: true } : {};

      print(
        await request(
          `/${subcommand === 'request' ? 'runbook-plans' : 'runbook-runs'}/${encodeURIComponent(file)}/${subcommand}`,
          subcommand === 'secret-bindings' ? undefined : body,
        ),
      );
    } else {
      throw new Error('Unknown runbook command. Run npm run keel -- --help.');
    }
  } else if (command === 'status') {
    print(await request('/snapshot'));
  } else if (command === 'secret' && subcommand === 'list') {
    const query = new URLSearchParams({
      project_id: required('project'),
      environment_id: required('environment'),
    });

    print(await request(`/secrets?${query}`));
  } else if (command === 'secret' && subcommand === 'create') {
    const input = {
      project_id: required('project'),
      environment_id: required('environment'),
      name: required('name'),
      value: await readSecret(),
    };

    print(await request('/secrets', input));
  } else if (command === 'secret' && ['rotate', 'revoke'].includes(subcommand)) {
    if (!file) {
      throw new Error('Provide a secret UUID.');
    }

    const input = {
      expected_revision: Number(required('revision')),
      ...(subcommand === 'rotate' ? { value: await readSecret() } : {}),
    };

    print(
      await request(
        `/secrets/${encodeURIComponent(file)}/${subcommand === 'rotate' ? 'versions' : 'revoke'}`,
        input,
      ),
    );
  } else if (command === 'deployment' && subcommand === 'secret-bindings') {
    if (!file) {
      throw new Error('Provide a deployment UUID.');
    }

    print(await request(`/deployments/${encodeURIComponent(file)}/secret-bindings`));
  } else if (command === 'deployment' && ['promotion', 'request'].includes(subcommand)) {
    const input = { release_id: required('release'), environment_id: required('environment') };

    const result =
      subcommand === 'request'
        ? await request('/deployments', input)
        : await request(
            `/releases/${encodeURIComponent(input.release_id)}/promotion?${new URLSearchParams({ environment_id: input.environment_id })}`,
          );

    print(result);
  } else if (command === 'deployment' && subcommand === 'rollback-candidates') {
    if (!file) {
      throw new Error('Provide a deployment UUID.');
    }

    const query = new URLSearchParams(values.cursor ? { cursor: values.cursor } : {});

    print(await request(`/deployments/${encodeURIComponent(file)}/rollback-candidates?${query}`));
  } else if (command === 'rollback' && subcommand === 'plan') {
    print(
      await request('/rollback-plans', {
        source_deployment_id: required('from'),
        candidate_deployment_id: required('candidate'),
      }),
    );
  } else if (command === 'rollback' && subcommand === 'request') {
    if (!file || !values['acknowledge-data-not-restored']) {
      throw new Error('Provide the reviewed plan UUID and --acknowledge-data-not-restored.');
    }

    print(
      await request(`/rollback-plans/${encodeURIComponent(file)}/request`, {
        acknowledge_data_not_restored: true,
      }),
    );
  } else if (command === 'integration' && subcommand === 'list') {
    print(await request('/integrations'));
  } else if (command === 'integration' && (subcommand === 'connect' || subcommand === 'rotate')) {
    const bitbucket = values.provider === 'bitbucket';

    if (values.provider && !['github', 'bitbucket'].includes(values.provider)) {
      throw new Error('--provider must be github or bitbucket.');
    }

    const credentials = bitbucket
      ? { token: process.env.KEEL_BITBUCKET_TOKEN, publish_secret: process.env.KEEL_PUBLISH_SECRET }
      : {
          token: process.env.KEEL_GITHUB_TOKEN,
          webhook_secret: process.env.KEEL_GITHUB_WEBHOOK_SECRET,
        };

    if (
      !credentials.token ||
      !(bitbucket ? credentials.publish_secret : credentials.webhook_secret)
    ) {
      throw new Error(
        bitbucket
          ? 'Set KEEL_BITBUCKET_TOKEN and KEEL_PUBLISH_SECRET.'
          : 'Set KEEL_GITHUB_TOKEN and KEEL_GITHUB_WEBHOOK_SECRET.',
      );
    }

    if (subcommand === 'connect') {
      const config = JSON.parse(await readFile(required('config'), 'utf8'));

      print(
        await request(bitbucket ? '/integrations/bitbucket' : '/integrations/github', {
          ...config,
          ...credentials,
        }),
      );
    } else {
      if (!file) {
        throw new Error('Provide a connection UUID.');
      }

      print(
        await request(
          `/integrations/${encodeURIComponent(file)}/${bitbucket ? 'bitbucket-credentials' : 'credentials'}`,
          credentials,
        ),
      );
    }
  } else if (command === 'integration' && ['enable', 'disable', 'pipelines'].includes(subcommand)) {
    if (!file) {
      throw new Error('Provide a connection UUID.');
    }

    const path = `/integrations/${encodeURIComponent(file)}`;

    if (subcommand === 'pipelines') {
      print(await request(`${path}/pipelines`));
    } else {
      print(await request(`${path}/state`, { enabled: subcommand === 'enable' }));
    }
  } else if (command === 'artifact' && subcommand === 'publish-bitbucket') {
    if (!file) {
      throw new Error('Provide an artifact file.');
    }

    // The publisher prints its own errors; pass its exit status through unchanged.
    const publisher = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../scripts/publish-bitbucket.mjs', import.meta.url)),
        file,
        required('connection'),
      ],
      { stdio: 'inherit' },
    );

    if (publisher.error) {
      throw publisher.error;
    }

    process.exitCode = publisher.status ?? 1;
  } else if (command === 'artifact' && subcommand === 'import') {
    print(
      await request(`/integrations/${encodeURIComponent(required('connection'))}/imports`, {
        run_id: required('run'),
        run_attempt: Number(values.attempt ?? 1),
      }),
    );
  } else if (command === 'import' && subcommand === 'retry') {
    if (!file) {
      throw new Error('Provide an import UUID.');
    }

    print(await request(`/imports/${encodeURIComponent(file)}/retry`, {}));
  } else if (command === 'artifact' && subcommand === 'publish') {
    if (!file) {
      throw new Error('Provide an artifact file.');
    }

    if ((await stat(file)).size > 25 * 1024 * 1024) {
      throw new Error('Artifacts are limited to 25 MB.');
    }

    const bytes = await readFile(file);

    const query = new URLSearchParams({
      project_id: required('project'),
      name: required('name'),
      version: required('version'),
      digest: createHash('sha256').update(bytes).digest('hex'),
    });

    print(await request(`/artifacts?${query}`, bytes));
  } else if (command === 'release' && subcommand === 'create') {
    print(
      await request('/releases', {
        project_id: required('project'),
        artifact_id: required('artifact'),
        version: required('version'),
        process: parseProcess(await readFile(required('process'), 'utf8')),
      }),
    );
  } else {
    throw new Error('Unknown command. Run npm run keel -- --help.');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'Command failed.', !!values.json);
}
