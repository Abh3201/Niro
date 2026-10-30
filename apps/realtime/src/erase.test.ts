import { CloseCode, MemoryStorage } from "@niro/sync";
import { issueEraseToken, issueToken } from "@niro/sync/auth";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAssets } from "./assets";
import type { RealtimeServerOptions } from "./server";
import { BOARD, closeCode, Harness, SECRET, until } from "./testing";

const h = new Harness();

afterEach(async () => {
  await h.stop();
});

/** A server whose erase forgets the board in `storage`, and records which boards were erased. */
async function start(options: Partial<RealtimeServerOptions> = {}) {
  const storage = new MemoryStorage();
  const erased: string[] = [];
  await h.start({
    storage,
    async erase(boardId) {
      erased.push(boardId);
      storage.erase(boardId);
    },
    ...options,
  });
  return { storage, erased };
}

const erase = (token: string, board = BOARD) =>
  fetch(`http://${h.base}/erase/${board}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });

describe("erasing a board", () => {
  it("closes its connections, deletes it and keeps it closed while old tokens last", async () => {
    const { storage, erased } = await start({});
    const tab = h.tab("edit");
    await until(() => tab.client.status === "online");
    tab.doc.getMap("m").set("x", 1);
    await until(() => h.server.rooms.get(BOARD)?.doc.getMap("m").get("x") === 1);

    const ws = await h.socket("edit");
    const closed = closeCode(ws);
    const res = await erase(issueEraseToken(SECRET, BOARD));
    expect(res.status).toBe(204);
    expect(await closed).toBe(CloseCode.Erased);
    expect(erased).toEqual([BOARD]);
    expect(h.server.rooms.has(BOARD)).toBe(false);
    expect(storage.rows(BOARD)).toBe(0);
    // A token from before the erase opens nothing, so the board isn't made again.
    expect(await h.upgradeStatus(h.url(issueToken(SECRET, BOARD, "edit")))).toBe(401);
    // Nor do the writes of a tab that still has it.
    tab.doc.getMap("m").set("y", 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(storage.rows(BOARD)).toBe(0);
  });

  it("refuses access tokens, other boards' erase tokens and other methods", async () => {
    const { erased } = await start({});
    expect((await erase(issueToken(SECRET, BOARD, "edit"))).status).toBe(401);
    expect((await erase(issueEraseToken(SECRET, "board-other1"))).status).toBe(401);
    expect((await erase("nonsense")).status).toBe(401);
    const get = await fetch(`http://${h.base}/erase/${BOARD}`);
    expect(get.status).toBe(405);
    expect(erased).toEqual([]);
  });

  it("answers the browser's preflight, since the dashboard calls it from another origin", async () => {
    await start({});
    const res = await fetch(`http://${h.base}/erase/${BOARD}`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("isn't there when the server has no way to erase", async () => {
    await h.start({});
    expect((await erase(issueEraseToken(SECRET, BOARD))).status).toBe(404);
  });

  it("refuses images uploaded with a token from before the erase", async () => {
    await start({ assets: new MemoryAssets() });
    await erase(issueEraseToken(SECRET, BOARD));
    const png = new Uint8Array(64).fill(1);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await fetch(`http://${h.base}/assets/${BOARD}`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        authorization: `Bearer ${issueToken(SECRET, BOARD, "edit")}`,
      },
      body: png,
    });
    expect(res.status).toBe(410);
  });
});
