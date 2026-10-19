import { fromWebSocket, PROTOCOL_VERSION, type Role, SyncClient } from "@niro/sync";
import { issueToken } from "@niro/sync/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createRealtimeServer, MAX_MESSAGE_BYTES, type RealtimeServer } from "./server";

const SECRET = "test-secret-0123456789abcdef0123456789";
const BOARD = "board-0123456789";

let server: RealtimeServer;
let base: string;
const cleanup: (() => void)[] = [];

beforeEach(async () => {
  server = createRealtimeServer({ secret: SECRET });
  const { port } = await server.listen(0, "127.0.0.1");
  base = `127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn();
  await server.close();
});

const url = (token: string, board = BOARD, v = PROTOCOL_VERSION) =>
  `ws://${base}/ws?v=${v}&board=${board}&token=${encodeURIComponent(token)}`;

/** The HTTP status the server answers an upgrade with, or 101. */
function upgradeStatus(address: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(address);
    ws.once("open", () => {
      ws.close();
      resolve(101);
    });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => {});
  });
}

/** A browser tab: a doc, presence and a SyncClient over a real WebSocket (Node's built-in one). */
function tab(role: Role = "edit", board = BOARD) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const client = new SyncClient({
    doc,
    awareness,
    connect: () =>
      fromWebSocket(new globalThis.WebSocket(url(issueToken(SECRET, board, role), board))),
  });
  cleanup.push(() => {
    client.destroy();
    awareness.destroy();
  });
  return { doc, awareness, client };
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("HTTP", () => {
  it("answers health checks", async () => {
    const res = await fetch(`http://${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://${base}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("upgrade", () => {
  it("needs a valid, unexpired token for this board and the current protocol", async () => {
    const token = issueToken(SECRET, BOARD, "edit");
    expect(await upgradeStatus(url(token))).toBe(101);
    expect(await upgradeStatus(url(""))).toBe(401);
    expect(
      await upgradeStatus(url(issueToken("another-secret-0123456789abcdef0123", BOARD, "edit"))),
    ).toBe(401);
    expect(await upgradeStatus(url(issueToken(SECRET, BOARD, "edit", Date.now() - 61_000)))).toBe(
      401,
    );
    expect(await upgradeStatus(url(issueToken(SECRET, "other-board-123", "edit")))).toBe(401);
    expect(await upgradeStatus(url(token, "bad id!"))).toBe(400);
    expect(await upgradeStatus(url(token, BOARD, PROTOCOL_VERSION + 1))).toBe(400);
    expect(await upgradeStatus(`ws://${base}/elsewhere`)).toBe(404);
  });
});

describe("rooms", () => {
  it("sync two tabs, and keep a viewer's edits out", async () => {
    const a = tab();
    const b = tab();
    const viewer = tab("view");
    await until(() => [a, b, viewer].every((t) => t.client.status === "online"));

    a.doc.getMap("m").set("x", 1);
    await until(() => b.doc.getMap("m").get("x") === 1 && viewer.doc.getMap("m").get("x") === 1);

    // The viewer's answer to the room's step 1 (its empty step 2) is refused
    // too. Wait for that, then count from there.
    const room = server.rooms.get(BOARD);
    await until(() => (room?.stats.updatesRefused ?? 0) >= 1);
    const refused = room?.stats.updatesRefused ?? 0;
    viewer.doc.getMap("m").set("x", 666);
    b.doc.getMap("m").set("y", 2);
    await until(() => a.doc.getMap("m").get("y") === 2);
    expect(a.doc.getMap("m").get("x")).toBe(1);
    expect(room?.stats.updatesRefused).toBe(refused + 1);
  });

  it("relays presence", async () => {
    const a = tab();
    const b = tab();
    a.awareness.setLocalState({ cursor: { x: 1, y: 2 } });
    await until(() => b.awareness.getStates().has(a.doc.clientID));
    expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({ cursor: { x: 1, y: 2 } });
  });

  it("forgets a board once everyone has left", async () => {
    const a = tab();
    await until(() => a.client.status === "online");
    expect(server.rooms.size).toBe(1);
    a.client.destroy();
    await until(() => server.rooms.size === 0);
  });

  it("closes a connection that sends a message over the size limit, and stays up", async () => {
    const ws = new WebSocket(url(issueToken(SECRET, BOARD, "view")));
    ws.on("error", () => {});
    await new Promise((resolve) => ws.once("open", resolve));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
    expect(await closed).toBe(1009);

    const a = tab();
    await until(() => a.client.status === "online");
  });

  it("closes clients with 1001 when the server shuts down", async () => {
    const ws = new WebSocket(url(issueToken(SECRET, BOARD, "edit")));
    await new Promise((resolve) => ws.once("open", resolve));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

    await server.close();
    server = createRealtimeServer({ secret: SECRET }); // afterEach closes a fresh, unstarted server

    expect(await closed).toBe(1001);
  });
});
