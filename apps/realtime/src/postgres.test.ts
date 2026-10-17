/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI sets it).
 * Each test gets its own schema, dropped afterwards, so any database will do.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PostgresStorage } from "./postgres";
import { BOARD, Harness, until } from "./testing";

const databaseUrl = process.env.TEST_DATABASE_URL;

it("has a database to test against in CI", () => {
  if (process.env.CI) expect(databaseUrl, "set TEST_DATABASE_URL").toBeTruthy();
});

describe.skipIf(!databaseUrl)("PostgresStorage", () => {
  let admin: pg.Pool;
  let schema = "";
  const opened: PostgresStorage[] = [];

  /** The test database, with the test's schema first on the search path. */
  const url = () => {
    const url = new URL(databaseUrl as string);
    url.searchParams.set("options", `-c search_path=${schema}`);
    return url.toString();
  };
  const open = async () => {
    const storage = await PostgresStorage.open(url());
    opened.push(storage);
    return storage;
  };
  const query = async <R extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<R>(sql, values)).rows;

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  });
  afterAll(async () => {
    await admin.end();
  });
  beforeEach(async () => {
    schema = `niro_test_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
  });
  afterEach(async () => {
    for (const storage of opened.splice(0)) await storage.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  it("creates the schema once, even when servers start together", async () => {
    await Promise.all([open(), open(), open()]);
    const rows = await query<{ version: number }>(`SELECT version FROM ${schema}.niro_migrations`);
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses a database a newer Niro has migrated", async () => {
    await open();
    await query(`INSERT INTO ${schema}.niro_migrations (version) VALUES (99)`);
    await expect(PostgresStorage.open(url())).rejects.toThrow(/schema version 99/);
  });

  it("stores updates, replaces them with a snapshot, and loads either", async () => {
    const storage = await open();
    expect(await storage.load(BOARD)).toEqual([]);

    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    doc.getMap("m").set("a", 1);
    doc.getText("t").insert(0, "hi");
    for (const update of updates) await storage.append(BOARD, update);

    const loaded = await storage.load(BOARD);
    expect(loaded).toHaveLength(2);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.mergeUpdates(loaded));
    expect(copy.getMap("m").toJSON()).toEqual({ a: 1 });
    expect(copy.getText("t").toString()).toBe("hi");

    await storage.replace(BOARD, Y.encodeStateAsUpdate(doc));
    expect(await storage.load(BOARD)).toHaveLength(1);
    const rows = await query(`SELECT 1 FROM ${schema}.board_updates WHERE board_id = $1`, [BOARD]);
    expect(rows).toHaveLength(0);

    doc.getMap("m").set("b", 2);
    await storage.append(BOARD, updates.at(-1) as Uint8Array);
    const again = new Y.Doc();
    Y.applyUpdate(again, Y.mergeUpdates(await storage.load(BOARD)));
    expect(again.getMap("m").toJSON()).toEqual({ a: 1, b: 2 });
    expect(await storage.load("board-never-seen")).toEqual([]);
  });

  it("keeps a board across a realtime server restart", async () => {
    const storage = await open();
    const h = new Harness();
    await h.start({ storage });
    const a = h.tab();
    await until(() => a.client.status === "online");
    a.doc.getMap("m").set("x", 1);
    await until(() => h.server.rooms.get(BOARD)?.doc.getMap("m").get("x") === 1);
    await h.server.close();
    a.close();

    await h.start({ storage });
    const b = h.tab();
    await until(() => b.doc.getMap("m").get("x") === 1);
    await h.stop();
  });
});
