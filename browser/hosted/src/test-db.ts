/**
 * Databases for the tests, on the machine's local Postgres. Each test file names its own so files can
 * run in parallel; `fresh` drops and recreates one for a test that needs an empty database.
 */
import pg from "pg";

const HOST = process.env.PGHOST ?? "/tmp";
const PORT = Number(process.env.PGPORT ?? 5432);

/**
 * A test database's name on this machine. Worktrees running the suites at once would drop each
 * other's databases, so ORBIT_TEST_DB_PREFIX moves every one of them under a prefix of their own.
 */
export const testDatabase = (name: string): string => {
  const prefix = process.env.ORBIT_TEST_DB_PREFIX;
  return prefix ? name.replace(/^(orbit_hosted_|orbit_soak_)/, prefix) : name;
};

export const connection = (database: string): pg.PoolConfig => ({ host: HOST, port: PORT, database });

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(connection("postgres"));
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

// Names come from the tests themselves, but a quoted identifier still can't be allowed to break out.
const ident = (name: string) => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Bad test database name: ${name}`);
  return `"${name}"`;
};

/** Create the database if it doesn't exist yet. */
export async function ensureDatabase(name: string): Promise<pg.PoolConfig> {
  await admin(async (client) => {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount === 0) await client.query(`CREATE DATABASE ${ident(name)}`);
  });
  return connection(name);
}

/** Drop the database if it exists and create it empty. */
export async function freshDatabase(name: string): Promise<pg.PoolConfig> {
  await admin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${ident(name)}`);
  });
  return connection(name);
}

export async function dropDatabase(name: string): Promise<void> {
  await admin((client) => client.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`));
}
