import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { transaction, type Database } from '../../../packages/database/src/index.js';

export async function dispatchOutbox(db: Database, client: Client, taskQueue: string) {
  return transaction(db, async (tx) => {
    const rows = await tx.query(`
      SELECT
        *
      FROM
        outbox
      WHERE
        delivered_at IS NULL
      ORDER BY
        created_at,
        id
      LIMIT
        50
      FOR UPDATE
        SKIP LOCKED
    `);

    for (const row of rows.rows) {
      if (['deployment.queued', 'runbook.queued'].includes(row.topic)) {
        try {
          await client.workflow.start('deploymentWorkflow', {
            workflowId: `${row.topic.split('.')[0]}-${row.payload.deployment_id}`,
            taskQueue,
            args: [row.organisation_id, row.payload.deployment_id],
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
          });
        } catch (error) {
          // A crash after Temporal accepts the start must not create a second run.
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
            throw error;
          }
        }
      }

      await tx.query('UPDATE outbox SET delivered_at=clock_timestamp() WHERE id=$1', [row.id]);
    }

    return rows.rowCount;
  });
}
