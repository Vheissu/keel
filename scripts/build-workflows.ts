import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

const bundle = await bundleWorkflowCode({
  workflowsPath: resolve('apps/workflow-worker/src/workflows.ts'),
});

await mkdir('apps/workflow-worker/dist', { recursive: true });
await writeFile('apps/workflow-worker/dist/workflows.cjs', bundle.code);
