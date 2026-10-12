import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import type { Database } from '../../../packages/database/src/index.js';

export async function dispatchOutbox(db: Database, client: Client, taskQueue: string) {
  const tx = await db.connect();

  try {
    await tx.query('BEGIN');

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
      if (row.topic === 'deployment.queued') {
        try {
          await client.workflow.start('deploymentWorkflow', {
            workflowId: `deployment-${row.payload.deployment_id}`,
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

    await tx.query('COMMIT');

    return rows.rowCount;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
