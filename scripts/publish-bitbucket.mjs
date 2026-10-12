#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

// Copy this standalone Node 22+ script into the repository that owns the pipeline.
async function publish() {
  const file = process.argv[2];
  const connection = process.argv[3] || process.env.KEEL_CONNECTION_ID;
  const secret = process.env.KEEL_PUBLISH_SECRET;
  const base = new URL(process.env.KEEL_URL || 'http://127.0.0.1:4040');

  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  ) {
    throw new Error('Use HTTPS for remote Keel servers.');
  }

  if (!file || !connection || !secret) {
    throw new Error(
      'Supply an artifact file and set KEEL_CONNECTION_ID, KEEL_PUBLISH_SECRET and KEEL_URL.',
    );
  }

  const run = process.env.BITBUCKET_PIPELINE_UUID;
  const step = process.env.BITBUCKET_STEP_UUID;
  const commit = process.env.BITBUCKET_COMMIT;

  if (!run || !step || !commit) {
    throw new Error('Run this publisher inside a Bitbucket pipeline step.');
  }

  if ((await stat(file)).size > 25 * 1024 * 1024) {
    throw new Error('The artifact exceeds the 25 MiB upload limit.');
  }

  const bytes = await readFile(file);

  if (!bytes.length || bytes.length > 25 * 1024 * 1024) {
    throw new Error('Artifacts must contain between 1 byte and 25 MiB.');
  }

  const digest = createHash('sha256').update(bytes).digest('hex');

  for (let attempt = 0; attempt < 3; attempt++) {
    let response;

    try {
      response = await fetch(
        new URL(`/publish/bitbucket/${encodeURIComponent(connection)}`, base),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/octet-stream',
            'X-Bitbucket-Pipeline': run,
            'X-Bitbucket-Step': step,
            'X-Bitbucket-Commit': commit,
            'X-Artifact-Sha256': digest,
          },
          body: bytes,
        },
      );
    } catch {
      if (attempt === 2) {
        throw new Error('Keel could not be reached after three upload attempts.');
      }
    }

    if (response?.ok) {
      console.log(JSON.stringify(await response.json(), null, 2));

      return;
    }

    if (response && response.status < 500 && response.status !== 429) {
      const result = await response.json().catch(() => ({}));

      throw new Error(
        `${result.error?.code || response.status}: ${result.error?.message || 'Artifact submission failed.'}`,
      );
    }

    await response?.body?.cancel();

    if (attempt < 2) {
      await setTimeout(1000 * 2 ** attempt);
    }
  }

  throw new Error('Keel could not accept the artifact after three upload attempts.');
}

try {
  await publish();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Artifact submission failed.');
  process.exitCode = 1;
}
