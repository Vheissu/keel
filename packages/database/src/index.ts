import pg from 'pg';

export type { Pool as Database, PoolClient as Transaction } from 'pg';

export function database(url: string) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

// Runs work inside BEGIN/COMMIT on a dedicated client, rolling back on any error.
export async function transaction<T>(
  db: pg.Pool,
  work: (tx: pg.PoolClient) => Promise<T>,
  begin = 'BEGIN',
): Promise<T> {
  const tx = await db.connect();
  let broken: Error | undefined;

  try {
    await tx.query(begin);
    const result = await work(tx);

    await tx.query('COMMIT');

    return result;
  } catch (error) {
    // A failed rollback leaves the connection unusable, so discard it instead of pooling it.
    await tx.query('ROLLBACK').catch((rollbackError: Error) => {
      broken = rollbackError;
    });

    throw error;
  } finally {
    tx.release(broken);
  }
}

export const readOnlySnapshot = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
