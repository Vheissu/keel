import pg from 'pg';

export const { Pool } = pg;

export type { Pool as Database, PoolClient as Transaction } from 'pg';

export function database(url: string) {
  return new pg.Pool({ connectionString: url, max: 10 });
}
