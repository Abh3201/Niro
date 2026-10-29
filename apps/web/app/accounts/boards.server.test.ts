/**
 * Who has which boards, against a real Postgres (TEST_DATABASE_URL, as for
 * the realtime server's storage tests). Runs in a database of its own,
 * made and dropped here, since Better Auth's tables live in its schema.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("board lists", () => {
  const name = `niro_web_test_${randomBytes(5).toString("hex")}`;
  let admin: pg.Pool;
  let boards: typeof import("./boards.server");
  let pool: pg.Pool;
  let n = 0;

  /** A user, made directly in Better Auth's table. */
  async function user(): Promise<string> {
    const id = `user-${++n}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $1, $2, true, now(), now())`,
      [id, `${id}@example.com`],
    );
    return id;
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
    boards = await import("./boards.server");
    const db = await import("./db.server");
    // The first query sets the tables up.
    await boards.getBoardInfo("nothing-here-yet");
    pool = db.getPool() as pg.Pool;
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
    delete process.env.DATABASE_URL;
  });

  it("lists a new board as its owner's, and nobody else's", async () => {
    const [ana, ben] = [await user(), await user()];
    const id = await boards.createBoard(ana, "Plan");
    expect(await boards.listBoards(ana)).toMatchObject([
      { id, title: "Plan", role: "edit", owned: true, ownerless: false },
    ]);
    expect(await boards.listBoards(ben)).toEqual([]);
    expect(await boards.memberRole(ana, id)).toBe("edit");
    expect(await boards.memberRole(ben, id)).toBeNull();
  });

  it("keeps the best access a link gave, and lists boards made before accounts as ownerless", async () => {
    const ana = await user();
    await boards.recordVisit(ana, "board-legacy-0001", "view");
    expect(await boards.memberRole(ana, "board-legacy-0001")).toBe("view");
    await boards.recordVisit(ana, "board-legacy-0001", "edit");
    await boards.recordVisit(ana, "board-legacy-0001", "view");
    expect(await boards.listBoards(ana)).toMatchObject([
      {
        id: "board-legacy-0001",
        title: "Untitled board",
        role: "edit",
        owned: false,
        ownerless: true,
      },
    ]);
  });

  it("lets only an editor take a board nobody owns, and only once", async () => {
    const [viewer, editor, late] = [await user(), await user(), await user()];
    await boards.recordVisit(viewer, "board-legacy-0002", "view");
    await boards.recordVisit(editor, "board-legacy-0002", "edit");
    await boards.recordVisit(late, "board-legacy-0002", "edit");
    expect(await boards.claimBoard(viewer, "board-legacy-0002")).toBe(false);
    expect(await boards.claimBoard(editor, "board-legacy-0002")).toBe(true);
    expect(await boards.claimBoard(late, "board-legacy-0002")).toBe(false);
    expect((await boards.getBoardInfo("board-legacy-0002"))?.ownerId).toBe(editor);
  });

  it("lets only the owner rename or delete, and a deleted board opens for nobody", async () => {
    const [owner, editor] = [await user(), await user()];
    const id = await boards.createBoard(owner);
    await boards.recordVisit(editor, id, "edit");
    expect(await boards.renameBoard(editor, id, "Mine now")).toBe(false);
    expect(await boards.deleteBoard(editor, id)).toBe(false);
    expect(await boards.renameBoard(owner, id, "Retro")).toBe(true);
    expect((await boards.getBoardInfo(id))?.title).toBe("Retro");

    expect(await boards.deleteBoard(owner, id)).toBe(true);
    expect((await boards.getBoardInfo(id))?.deleted).toBe(true);
    expect(await boards.listBoards(owner)).toEqual([]);
    expect(await boards.listBoards(editor)).toEqual([]);
    expect(await boards.memberRole(editor, id)).toBeNull();
    // A link opened afterwards doesn't bring it back.
    await boards.recordVisit(editor, id, "edit");
    expect(await boards.listBoards(editor)).toEqual([]);

    expect(await boards.unerasedBoards(owner)).toEqual([id]);
    await boards.markErased(owner, id);
    expect(await boards.unerasedBoards(owner)).toEqual([]);
  });

  it("takes someone else's board off a list, but never the owner's own", async () => {
    const [owner, friend] = [await user(), await user()];
    const id = await boards.createBoard(owner);
    await boards.recordVisit(friend, id, "view");
    await boards.removeFromList(friend, id);
    await boards.removeFromList(owner, id);
    expect(await boards.listBoards(friend)).toEqual([]);
    expect(await boards.listBoards(owner)).toHaveLength(1);
  });

  it("tidies titles", () => {
    expect(boards.cleanTitle("  Q3\u0000  plan\n ")).toBe("Q3 plan");
    expect(boards.cleanTitle("   ")).toBeNull();
    expect(boards.cleanTitle(42)).toBeNull();
    expect([...(boards.cleanTitle("x".repeat(200)) ?? "")]).toHaveLength(80);
  });
});
