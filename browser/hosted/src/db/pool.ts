/** The Postgres pools the host and its workers use. */
import pg from "pg";

/**
 * A pool that outlives Postgres dropping its idle connections (a restart, a failover, an admin's
 * pg_terminate_backend). pg reports that as an 'error' on the pool, which takes the process down
 * when nothing listens; the pool itself replaces the connection on the next query.
 */
export function createPool(config: pg.PoolConfig, log?: (message: string) => void): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on("error", (error) => log?.(`database connection lost: ${error.message}`));
  return pool;
}
