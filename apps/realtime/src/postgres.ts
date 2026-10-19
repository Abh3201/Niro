import type { BoardStorage } from "@niro/sync";
import pg from "pg";
import type { AssetStorage, ImageType, PutResult, StoredAsset } from "./assets";

/**
 * The schema, one step per entry, applied in order and recorded in
 * `niro_migrations`. Never change a step that has shipped: add another.
 *
 * A board is a snapshot (all of it, as one Yjs update, written by
 * compaction) plus the updates written since. Loading applies them all;
 * Yjs doesn't care about order or duplicates.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE boards (
     id text PRIMARY KEY,
     snapshot bytea,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE board_updates (
     board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
     seq bigint GENERATED ALWAYS AS IDENTITY,
     data bytea NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (board_id, seq)
   );`,
  // Images, by board and SHA-256. No reference to boards: an image can be
  // uploaded before the board's first write.
  `CREATE TABLE board_assets (
     board_id text NOT NULL,
     id text NOT NULL,
     type text NOT NULL,
     data bytea NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (board_id, id)
   );`,
];

/** Advisory lock key for migrations: any number, as long as nothing else uses it. */
const MIGRATION_LOCK = 0x6e69726f; // "niro"

export interface PostgresOptions {
  /** Connections in the pool. Default 10. */
  max?: number;
  /** Called when an idle connection fails (the database restarted, say). */
  onError?: (error: Error) => void;
}

/**
 * Boards in Postgres. One realtime server per database: two servers
 * writing the same board would each compact away the other's rows.
 */
export class PostgresStorage implements BoardStorage, AssetStorage {
  private constructor(private readonly pool: pg.Pool) {}

  /** Connects and brings the schema up to date. */
  static async open(connectionString: string, options: PostgresOptions = {}) {
    const pool = new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      // Fail instead of waiting forever when the database is unreachable.
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
    // Without a listener, an idle connection's error would crash the process.
    pool.on("error", (error) => options.onError?.(error));
    try {
      await migrate(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return new PostgresStorage(pool);
  }

  async load(boardId: string): Promise<Uint8Array[]> {
    // One statement, so it can't see a compaction half done.
    const { rows } = await this.pool.query<{ data: Buffer }>(
      `SELECT snapshot AS data FROM boards WHERE id = $1 AND snapshot IS NOT NULL
       UNION ALL
       SELECT data FROM board_updates WHERE board_id = $1`,
      [boardId],
    );
    return rows.map((row) => row.data);
  }

  async append(boardId: string, update: Uint8Array): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO boards (id) VALUES ($1)
         ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
        [boardId],
      );
      await client.query("INSERT INTO board_updates (board_id, data) VALUES ($1, $2)", [
        boardId,
        update,
      ]);
    });
  }

  async replace(boardId: string, state: Uint8Array): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO boards (id, snapshot) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = now()`,
        [boardId, state],
      );
      await client.query("DELETE FROM board_updates WHERE board_id = $1", [boardId]);
    });
  }

  async put(
    boardId: string,
    id: string,
    asset: StoredAsset,
    maxBoardBytes: number,
  ): Promise<PutResult> {
    let result: PutResult = "stored";
    await this.transaction(async (client) => {
      // One upload per board at a time, so two can't both fit under the cap.
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        MIGRATION_LOCK,
        boardId,
      ]);
      const { rows } = await client.query<{ total: string; present: boolean }>(
        `SELECT coalesce(sum(length(data)), 0) AS total, bool_or(id = $2) AS present
         FROM board_assets WHERE board_id = $1`,
        [boardId, id],
      );
      const row = rows[0];
      if (row?.present) {
        result = "exists";
        return;
      }
      if (Number(row?.total ?? 0) + asset.data.byteLength > maxBoardBytes) {
        result = "full";
        return;
      }
      await client.query(
        "INSERT INTO board_assets (board_id, id, type, data) VALUES ($1, $2, $3, $4)",
        [boardId, id, asset.type, asset.data],
      );
    });
    return result;
  }

  async get(boardId: string, id: string): Promise<StoredAsset | null> {
    const { rows } = await this.pool.query<{ type: string; data: Buffer }>(
      "SELECT type, data FROM board_assets WHERE board_id = $1 AND id = $2",
      [boardId, id],
    );
    const row = rows[0];
    return row ? { type: row.type as ImageType, data: row.data } : null;
  }

  /** Closes every connection. Call after the last write. */
  close(): Promise<void> {
    return this.pool.end();
  }

  private transaction(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    return inTransaction(this.pool, fn);
  }
}

async function inTransaction(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: Error) => {
      // The connection itself failed: don't hand it out again.
      broken = rollbackError;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

async function migrate(pool: pg.Pool): Promise<void> {
  await inTransaction(pool, async (client) => {
    // Servers starting together: one migrates while the others wait here,
    // then find nothing left to do.
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS niro_migrations (
         version integer PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ version: number | null }>(
      "SELECT max(version) AS version FROM niro_migrations",
    );
    const current = rows[0]?.version ?? 0;
    if (current > MIGRATIONS.length) {
      throw new Error(
        `The database is at schema version ${current}, newer than this server's ${MIGRATIONS.length}. Run a newer Niro.`,
      );
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      await client.query(MIGRATIONS[version] as string);
      await client.query("INSERT INTO niro_migrations (version) VALUES ($1)", [version + 1]);
    }
  });
}
