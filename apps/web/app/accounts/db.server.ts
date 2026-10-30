/**
 * The web app's database: accounts (Better Auth's tables) and which boards
 * belong to whom. Only when `DATABASE_URL` is set; without it there are no
 * accounts and Niro works as it always has, by link alone. See
 * docs/decisions/0015-accounts.md.
 */
import pg from "pg";
import { emailEnabled } from "./email.server";

/**
 * The web app's own tables, one step per entry, applied in order and recorded
 * in `niro_web_migrations`. Never change a step that has shipped: add one.
 *
 * Better Auth's tables come first (`user`, `session`, `account`,
 * `verification`, `rateLimit`), made by Better Auth itself. The realtime
 * server's tables (`boards`, `board_updates`, ...) share the database and
 * are never touched here; `board_info` is named so it can't clash.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE board_info (
     board_id text PRIMARY KEY,
     owner_id text REFERENCES "user" (id) ON DELETE SET NULL,
     title text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     deleted_at timestamptz,
     erased_at timestamptz
   );
   CREATE INDEX board_info_owner ON board_info (owner_id) WHERE deleted_at IS NULL;
   CREATE TABLE board_members (
     user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
     board_id text NOT NULL REFERENCES board_info (board_id) ON DELETE CASCADE,
     role text NOT NULL CHECK (role IN ('edit', 'view')),
     opened_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, board_id)
   );
   CREATE INDEX board_members_recent ON board_members (user_id, opened_at DESC);`,
];

/** Advisory lock for migrations: not the realtime server's (0x6e69726f), so neither waits on the other. */
const MIGRATION_LOCK = 0x6e697277; // "nirw"

let pool: pg.Pool | null | undefined;

/** The pool, or null without `DATABASE_URL`. Doesn't connect yet. */
export function getPool(): pg.Pool | null {
  if (pool !== undefined) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    pool = null;
    return pool;
  }
  pool = new pg.Pool({
    connectionString,
    // Serverless hosts run many small instances: keep each one's share small.
    max: Number(process.env.NIRO_DB_POOL ?? 5),
    // A free Neon database sleeps when idle and takes a moment to wake.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });
  // Without a listener, an idle connection's error would crash the process.
  pool.on("error", (error) => console.error("postgres connection error:", error.message));
  return pool;
}

/** True when Google sign-in is set up. */
export function googleEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

let warned = false;

/**
 * True when there are accounts: the web app has a database and a way to
 * sign in (Google, or email), and, in production, knows its address
 * (`PUBLIC_URL`). Otherwise nothing mentions signing in.
 */
export function accountsEnabled(): boolean {
  if (getPool() === null || !(googleEnabled() || emailEnabled())) return false;
  if (process.env.NODE_ENV === "production" && !process.env.PUBLIC_URL) {
    if (!warned) {
      warned = true;
      console.error(
        "Accounts are off: set PUBLIC_URL to the address people open Niro at, like https://board.example.com",
      );
    }
    return false;
  }
  return true;
}

/**
 * Brings the schema up to date: Better Auth's tables (`authMigrations`),
 * then the web app's own. Under an advisory lock, so instances starting
 * together take turns.
 */
export async function setUpDatabase(
  db: pg.Pool,
  authMigrations: () => Promise<void>,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await authMigrations();
      await migrate(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}

async function migrate(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TABLE IF NOT EXISTS niro_web_migrations (
         version integer PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ version: number | null }>(
      "SELECT max(version) AS version FROM niro_web_migrations",
    );
    const current = rows[0]?.version ?? 0;
    if (current > MIGRATIONS.length) {
      throw new Error(
        `The database was set up by a newer Niro (web schema ${current}, this one knows ${MIGRATIONS.length}).`,
      );
    }
    for (let version = current + 1; version <= MIGRATIONS.length; version++) {
      await client.query(MIGRATIONS[version - 1] as string);
      await client.query("INSERT INTO niro_web_migrations (version) VALUES ($1)", [version]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
