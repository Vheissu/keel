import { proxyActivities, sleep, continueAsNew } from '@temporalio/workflow';

const activities = proxyActivities<{ tick(org: string, id: string): Promise<boolean> }>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
});

export async function deploymentWorkflow(org: string, id: string): Promise<void> {
  // Database state is authoritative for approval, cancellation and fenced results.
  // No target operations run in a Workflow or Activity.
  for (let iteration = 0; iteration < 500; iteration++) {
    if (await activities.tick(org, id)) {
      return;
    }

    await sleep('5 seconds');
  }

  await continueAsNew<typeof deploymentWorkflow>(org, id);
}
