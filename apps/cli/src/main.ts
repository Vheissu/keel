#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { parseProcess } from '../../../packages/deployment-schema/src/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    name: { type: 'string' },
    version: { type: 'string' },
    artifact: { type: 'string' },
    connection: { type: 'string' },
    run: { type: 'string' },
    attempt: { type: 'string' },
    config: { type: 'string' },
    process: { type: 'string' },
    'idempotency-key': { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

const help = `Keel · publish existing build outputs and create immutable releases

  npm run keel -- artifact publish <file> --project <uuid> --name application --version 1.0.0
  npm run keel -- release create --project <uuid> --artifact <uuid> --version 1.0.0 --process process.yaml
  npm run keel -- integration list
  npm run keel -- integration connect --config github.json
  npm run keel -- integration rotate <connection-uuid>
  npm run keel -- integration enable|disable|pipelines <connection-uuid>
  npm run keel -- artifact import --connection <uuid> --run <run-id> --attempt 1
  npm run keel -- import retry <import-uuid>
  npm run keel -- validate <process.yaml>
  npm run keel -- status --json

Set KEEL_URL (default http://127.0.0.1:4040) and KEEL_TOKEN.
Connection creation and rotation use KEEL_GITHUB_TOKEN and KEEL_GITHUB_WEBHOOK_SECRET.
For retryable CI steps, pass a stable --idempotency-key (8–128 characters).
Results are JSON. Deployment requests and approvals are available in the UI and API.
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

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      `${result.error?.code || response.status}: ${result.error?.message || 'Request failed.'}`,
    );
  }

  return result;
}

try {
  const [command, subcommand, file] = positionals;

  if (values.help || !command) {
    console.log(help);
  } else if (command === 'validate') {
    if (!subcommand) {
      throw new Error('Provide a deployment process file.');
    }

    console.log(
      JSON.stringify(
        { valid: true, process: parseProcess(await readFile(subcommand, 'utf8')) },
        null,
        2,
      ),
    );
  } else if (command === 'status') {
    console.log(JSON.stringify(await request('/snapshot'), null, 2));
  } else if (command === 'integration' && subcommand === 'list') {
    console.log(JSON.stringify(await request('/integrations'), null, 2));
  } else if (command === 'integration' && (subcommand === 'connect' || subcommand === 'rotate')) {
    const credentials = {
      token: process.env.KEEL_GITHUB_TOKEN,
      webhook_secret: process.env.KEEL_GITHUB_WEBHOOK_SECRET,
    };

    if (!credentials.token || !credentials.webhook_secret) {
      throw new Error('Set KEEL_GITHUB_TOKEN and KEEL_GITHUB_WEBHOOK_SECRET.');
    }

    if (subcommand === 'connect') {
      const config = JSON.parse(await readFile(required('config'), 'utf8'));

      console.log(
        JSON.stringify(
          await request('/integrations/github', { ...config, ...credentials }),
          null,
          2,
        ),
      );
    } else {
      if (!file) {
        throw new Error('Provide a connection UUID.');
      }

      console.log(
        JSON.stringify(
          await request(`/integrations/${encodeURIComponent(file)}/credentials`, credentials),
          null,
          2,
        ),
      );
    }
  } else if (command === 'integration' && ['enable', 'disable', 'pipelines'].includes(subcommand)) {
    if (!file) {
      throw new Error('Provide a connection UUID.');
    }

    const path = `/integrations/${encodeURIComponent(file)}`;

    if (subcommand === 'pipelines') {
      console.log(JSON.stringify(await request(`${path}/pipelines`), null, 2));
    } else {
      console.log(
        JSON.stringify(
          await request(`${path}/state`, { enabled: subcommand === 'enable' }),
          null,
          2,
        ),
      );
    }
  } else if (command === 'artifact' && subcommand === 'import') {
    console.log(
      JSON.stringify(
        await request(`/integrations/${encodeURIComponent(required('connection'))}/imports`, {
          run_id: required('run'),
          run_attempt: Number(values.attempt ?? 1),
        }),
        null,
        2,
      ),
    );
  } else if (command === 'import' && subcommand === 'retry') {
    if (!file) {
      throw new Error('Provide an import UUID.');
    }

    console.log(
      JSON.stringify(await request(`/imports/${encodeURIComponent(file)}/retry`, {}), null, 2),
    );
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

    console.log(JSON.stringify(await request(`/artifacts?${query}`, bytes), null, 2));
  } else if (command === 'release' && subcommand === 'create') {
    console.log(
      JSON.stringify(
        await request('/releases', {
          project_id: required('project'),
          artifact_id: required('artifact'),
          version: required('version'),
          process: parseProcess(await readFile(required('process'), 'utf8')),
        }),
        null,
        2,
      ),
    );
  } else {
    throw new Error('Unknown command. Run npm run keel -- --help.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Command failed.';

  console.error(values.json ? JSON.stringify({ error: message }) : message);
  process.exitCode = 1;
}
