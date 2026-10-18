import { connect } from "node:net";
import {
  type BoardStorage,
  MemoryStorage,
  MessageType,
  PROTOCOL_VERSION,
  syncUpdate,
} from "@niro/sync";
import { issueToken } from "@niro/sync/auth";
import * as encoding from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import { DEFAULT_LIMITS, type RealtimeServerOptions } from "./server";
import { BOARD, closeCode, Harness, SECRET, slowWrites, until } from "./testing";

const h = new Harness();
const quiet = { log: () => {} };
const OTHER_BOARD = "board-other1";

beforeEach(async () => {
  await h.start();
});

afterEach(async () => {
  await h.stop();
});

/** Restarts the server with these options, on a new port. */
async function restart(options: Partial<RealtimeServerOptions>) {
  await h.server.close();
  await h.start(options);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Yjs update of a little over `bytes` bytes. */
function updateOf(bytes: number): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("m").set("x", "a".repeat(bytes));
  return Y.encodeStateAsUpdate(doc);
}

function syncStep2(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  encoding.writeVarUint(encoder, sync.messageYjsSyncStep2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

describe("HTTP", () => {
  it("answers health checks", async () => {
    const res = await fetch(`http://${h.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://${h.base}/nope`);
    expect(res.status).toBe(404);
  });

  it("stays up after request targets that aren't valid URLs", async () => {
    const [host, port] = h.base.split(":") as [string, string];
    for (const upgrade of [false, true]) {
      const socket = connect(Number(port), host);
      await new Promise((resolve) => socket.once("connect", resolve));
      const response = new Promise<string>((resolve) => {
        socket.once("data", (data) => resolve(String(data)));
      });
      socket.write(
        `GET //[ HTTP/1.1\r\nHost: ${h.base}\r\n` +
          (upgrade
            ? "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
            : "") +
          "\r\n",
      );
      expect(await response).toMatch(/^HTTP\/1\.1 404/);
      socket.destroy();
    }
    const res = await fetch(`http://${h.base}/healthz`);
    expect(res.status).toBe(200);
  });

  it("serves metrics in the Prometheus text format", async () => {
    const a = h.tab();
    await until(() => a.client.status === "online");
    const res = await fetch(`http://${h.base}/metrics`);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("# TYPE niro_connections gauge\nniro_connections 1\n");
    expect(text).toContain("\nniro_rooms 1\n");
    expect(text).toMatch(/\nniro_messages_received_total [1-9]/);
    expect(text).toContain('\nniro_connections_rejected_total{reason="room_full"} 0\n');
    expect(text).toContain('\nniro_flush_duration_seconds_bucket{le="+Inf"} 0\n');
  });

  it("keeps metrics behind a token when one is set", async () => {
    await restart({ metricsToken: "scrape-me" });
    const metrics = (authorization?: string) =>
      fetch(`http://${h.base}/metrics`, authorization ? { headers: { authorization } } : {});
    expect((await metrics()).status).toBe(401);
    expect((await metrics("Bearer nope")).status).toBe(401);
    expect((await metrics("Bearer scrape-me")).status).toBe(200);
  });
});

describe("upgrade", () => {
  it("needs a valid, unexpired token for this board and the current protocol", async () => {
    const token = h.token();
    expect(await h.upgradeStatus(h.url(token))).toBe(101);
    expect(await h.upgradeStatus(h.url(""))).toBe(401);
    const otherSecret = issueToken("another-secret-0123456789abcdef0123", BOARD, "edit");
    expect(await h.upgradeStatus(h.url(otherSecret))).toBe(401);
    const expired = issueToken(SECRET, BOARD, "edit", Date.now() - 61_000);
    expect(await h.upgradeStatus(h.url(expired))).toBe(401);
    expect(await h.upgradeStatus(h.url(issueToken(SECRET, "other-board-123", "edit")))).toBe(401);
    expect(await h.upgradeStatus(h.url(token, "bad id!"))).toBe(400);
    expect(await h.upgradeStatus(h.url(token, BOARD, PROTOCOL_VERSION + 1))).toBe(400);
    expect(await h.upgradeStatus(`ws://${h.base}/elsewhere`)).toBe(404);
  });

  it("refuses connections past the per-board limit, and takes them again once some leave", async () => {
    await restart({ limits: { connectionsPerRoom: 2 } });
    const first = await h.socket();
    await h.socket();
    expect(await h.upgradeStatus(h.url(h.token()))).toBe(503);
    // Other boards aren't affected.
    expect(await h.upgradeStatus(h.url(h.token("edit", OTHER_BOARD), OTHER_BOARD))).toBe(101);

    first.close();
    await closeCode(first);
    // The server sees the close a moment after the client does.
    let status = 0;
    for (let i = 0; i < 50 && status !== 101; i++) {
      status = await h.upgradeStatus(h.url(h.token()));
      if (status !== 101) await sleep(20);
    }
    expect(status).toBe(101);
  });

  it("answers 503 when the board can't be loaded", async () => {
    const failing: BoardStorage = {
      load: () => Promise.reject(new Error("database down")),
      append: () => Promise.resolve(),
      replace: () => Promise.resolve(),
    };
    await restart({ storage: failing, ...quiet });
    expect(await h.upgradeStatus(h.url(h.token()))).toBe(503);
    expect(h.server.rooms.size).toBe(0);
  });

  it("gives the board back when the client leaves while it's loading", async () => {
    const storage = new MemoryStorage();
    let loading = false;
    let finishLoading = () => {};
    const gate = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const slow: BoardStorage = {
      load: async (id) => {
        loading = true;
        await gate;
        return storage.load(id);
      },
      append: (id, update) => storage.append(id, update),
      replace: (id, state) => storage.replace(id, state),
    };
    await restart({ storage: slow });
    const ws = new WebSocket(h.url(h.token()));
    ws.on("error", () => {});
    await until(() => loading);
    ws.terminate();
    await sleep(50);
    finishLoading();
    await sleep(50);
    // Loaded, handed back, closed: nobody holds it.
    expect(h.server.rooms.size).toBe(0);

    const a = h.tab();
    await until(() => a.client.status === "online");
  });

  it("survives a client resetting the connection while its board loads", async () => {
    let finishLoading = () => {};
    const gate = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const storage = new MemoryStorage();
    await restart({
      storage: {
        load: (id) => gate.then(() => storage.load(id)),
        append: (id, update) => storage.append(id, update),
        replace: (id, state) => storage.replace(id, state),
      },
    });
    const [host, port] = h.base.split(":") as [string, string];
    const socket = connect(Number(port), host);
    await new Promise((resolve) => socket.once("connect", resolve));
    const path = new URL(h.url(h.token())).pathname + new URL(h.url(h.token())).search;
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${h.base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await sleep(50);
    socket.resetAndDestroy();
    await sleep(50);
    finishLoading();
    await sleep(50);
    expect(h.server.rooms.size).toBe(0);
    const a = h.tab();
    await until(() => a.client.status === "online");
  });
});

describe("rooms", () => {
  it("sync two tabs, and keep a viewer's edits out", async () => {
    const a = h.tab();
    const b = h.tab();
    const viewer = h.tab("view");
    await until(() => [a, b, viewer].every((t) => t.client.status === "online"));

    a.doc.getMap("m").set("x", 1);
    await until(() => b.doc.getMap("m").get("x") === 1 && viewer.doc.getMap("m").get("x") === 1);

    // The viewer's answer to the room's step 1 (its empty step 2) is refused
    // too. Wait for that, then count from there.
    const room = h.server.rooms.get(BOARD);
    await until(() => (room?.stats.updatesRefused ?? 0) >= 1);
    const refused = room?.stats.updatesRefused ?? 0;
    viewer.doc.getMap("m").set("x", 666);
    b.doc.getMap("m").set("y", 2);
    await until(() => a.doc.getMap("m").get("y") === 2);
    expect(a.doc.getMap("m").get("x")).toBe(1);
    expect(room?.stats.updatesRefused).toBe(refused + 1);
  });

  it("relays presence", async () => {
    const a = h.tab();
    const b = h.tab();
    a.awareness.setLocalState({ cursor: { x: 1, y: 2 } });
    await until(() => b.awareness.getStates().has(a.doc.clientID));
    expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({ cursor: { x: 1, y: 2 } });
  });

  it("turns a board read-only when it's full, and says so to everyone", async () => {
    await restart({ limits: { shapes: 2 } });
    const a = h.tab();
    await until(() => a.client.status === "online");
    const shapes = a.doc.getMap("shapes");
    shapes.set("s1", new Y.Map());
    shapes.set("s2", new Y.Map());
    await until(() => a.client.readOnly === "full");

    const b = h.tab();
    await until(() => b.client.status === "online");
    expect(b.client.readOnly).toBe("full");
    shapes.set("s3", new Y.Map());
    await sleep(100);
    const stored = h.server.rooms.get(BOARD)?.doc.getMap("shapes");
    expect([...(stored?.keys() ?? [])].sort()).toEqual(["s1", "s2"]);
    expect(b.doc.getMap("shapes").size).toBe(2);
  });
});

describe("limits", () => {
  it("lets a big catch-up through, but closes a big live message with 1009", async () => {
    await restart({ limits: { messageBytes: 1000 } });
    const ws = await h.socket();
    ws.send(syncStep2(updateOf(5000)));
    await until(() => h.server.rooms.get(BOARD)?.doc.getMap("m").has("x") === true);

    const closed = closeCode(ws);
    ws.send(syncUpdate(updateOf(5000)));
    expect(await closed).toBe(1009);
  });

  it("closes a connection that sends a message over the ceiling, and stays up", async () => {
    // The ceiling is twice the document limit: 2,000 bytes here.
    await restart({ limits: { documentBytes: 1000 } });
    const ws = await h.socket("view");
    const closed = closeCode(ws);
    ws.send(new Uint8Array(3000));
    expect(await closed).toBe(1009);

    const a = h.tab();
    await until(() => a.client.status === "online");
  });

  it("closes a connection that sends a flood of messages with 4029", async () => {
    await restart({ limits: { messagesPerSecond: 5 } });
    const ws = await h.socket();
    const closed = closeCode(ws);
    for (let i = 0; i < 30; i++) ws.send(Uint8Array.of(MessageType.Heartbeat));
    expect(await closed).toBe(4029);
  });

  it("allows a steady pace under the limit", async () => {
    await restart({ limits: { messagesPerSecond: 50 } });
    const ws = await h.socket();
    let closed = false;
    ws.once("close", () => {
      closed = true;
    });
    // 40 a second, for a second.
    for (let i = 0; i < 40; i++) {
      ws.send(Uint8Array.of(MessageType.Heartbeat));
      await sleep(25);
    }
    expect(closed).toBe(false);
    ws.close();
  });

  it("closes a connection that sends text with 1007", async () => {
    const ws = await h.socket();
    const closed = closeCode(ws);
    ws.send("hello");
    expect(await closed).toBe(1007);
  });

  it("start from the plan's values", () => {
    expect(DEFAULT_LIMITS).toEqual({
      messageBytes: 1024 * 1024,
      documentBytes: 20 * 1024 * 1024,
      shapes: 10_000,
      connectionsPerRoom: 100,
      messagesPerSecond: 200,
      bytesPerSecond: 1024 * 1024,
    });
  });
});

describe("storage", () => {
  it("writes a board when everyone has left, and loads it for the next visitor", async () => {
    const storage = new MemoryStorage();
    await restart({ storage });
    const a = h.tab();
    await until(() => a.client.status === "online");
    a.doc.getMap("m").set("x", 1);
    await until(() => h.server.rooms.get(BOARD)?.doc.getMap("m").get("x") === 1);
    a.close();
    await until(() => h.server.rooms.size === 0);
    expect(storage.rows(BOARD)).toBeGreaterThan(0);

    const b = h.tab();
    await until(() => b.doc.getMap("m").get("x") === 1);
  });

  it("writes every board when the server shuts down, so a restart loses nothing", async () => {
    const storage = new MemoryStorage();
    await restart({ storage: slowWrites(storage, 100) });
    const a = h.tab();
    const other = h.tab("edit", OTHER_BOARD);
    await until(() => a.client.status === "online" && other.client.status === "online");
    a.doc.getMap("m").set("x", 1);
    other.doc.getMap("m").set("y", 2);
    await until(() => h.server.rooms.get(BOARD)?.doc.getMap("m").get("x") === 1);
    await until(() => h.server.rooms.get(OTHER_BOARD)?.doc.getMap("m").get("y") === 2);

    // Still connected, and well inside the 2 s write delay.
    expect(storage.rows(BOARD)).toBe(0);
    await h.server.close();
    // Closing waits for the writes.
    expect(storage.rows(BOARD)).toBeGreaterThan(0);
    expect(storage.rows(OTHER_BOARD)).toBeGreaterThan(0);
    // Gone for good, so the next server can only get the boards from storage.
    a.close();
    other.close();
    await h.start({ storage });

    const b = h.tab();
    const c = h.tab("edit", OTHER_BOARD);
    await until(() => b.doc.getMap("m").get("x") === 1 && c.doc.getMap("m").get("y") === 2);
  });

  it("closes clients with 1001 when the server shuts down", async () => {
    const ws = await h.socket();
    const closed = closeCode(ws);
    await h.server.close();
    await h.start(); // afterEach stops a fresh server
    expect(await closed).toBe(1001);
  });
});
