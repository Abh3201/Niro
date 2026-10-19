import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { BOARD_ID, CloseCode, type Peer, PROTOCOL_VERSION, type Role, Room } from "@niro/sync";
import { verifyToken } from "@niro/sync/auth";
import { type WebSocket, WebSocketServer } from "ws";

/** Largest single WebSocket message accepted, in bytes. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Queued bytes above which a connection's cursor updates are skipped. */
const SOFT_BUFFER_BYTES = 256 * 1024;
/**
 * Queued bytes above which a connection is dropped. A client that far behind
 * catches up faster by reconnecting: the sync handshake sends only what it's
 * missing, once, instead of every intermediate update.
 */
const HARD_BUFFER_BYTES = 8 * 1024 * 1024;

export interface RealtimeServerOptions {
  /** Signs access tokens; shared with the web app (`NIRO_SECRET`). */
  secret: string;
  /** Pings every connection this often and drops those that missed the last ping. */
  pingIntervalMs?: number;
}

export interface RealtimeServer {
  listen(port: number, host?: string): Promise<AddressInfo>;
  /** Closes every client with code 1001 ("going away"), then stops listening. */
  close(): Promise<void>;
  /** Boards with someone connected. */
  readonly rooms: ReadonlyMap<string, Room>;
}

/**
 * The realtime server: one `Room` per open board, kept in memory while
 * anyone is connected. P3a has no storage: the board lives in the browsers
 * (IndexedDB) and the room is rebuilt from them, so a board nobody has open
 * isn't on the server at all. P3b adds Postgres.
 */
export function createRealtimeServer(options: RealtimeServerOptions): RealtimeServer {
  const rooms = new Map<string, Room>();
  const alive = new WeakMap<WebSocket, boolean>();

  const http = createServer((req, res) => {
    if (req.method === "GET" && pathname(req) === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  // Checked before the upgrade, so a refused client costs one HTTP response.
  // Browsers can't read the status, so the client learns of a bad link from
  // the web app's token endpoint, not from here.
  http.on("upgrade", (req, socket, head) => {
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return refuse("404 Not Found");
    if (url.searchParams.get("v") !== String(PROTOCOL_VERSION)) return refuse("400 Bad Request");
    const boardId = url.searchParams.get("board") ?? "";
    if (!BOARD_ID.test(boardId)) return refuse("400 Bad Request");
    const grant = verifyToken(options.secret, url.searchParams.get("token") ?? "");
    if (!grant || grant.boardId !== boardId) return refuse("401 Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, boardId, grant.role));
  });

  function connect(ws: WebSocket, boardId: string, role: Role): void {
    let room = rooms.get(boardId);
    if (!room) {
      room = new Room();
      rooms.set(boardId, room);
    }
    const joined = room;
    const peer: Peer = {
      send(data, droppable) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > HARD_BUFFER_BYTES) {
          ws.terminate();
          return;
        }
        if (droppable && ws.bufferedAmount > SOFT_BUFFER_BYTES) return;
        ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    // A protocol error (a message over the size limit, a bad frame): ws closes
    // the connection itself. Without a listener, the error would crash the process.
    ws.on("error", () => {});
    ws.on("message", (data, isBinary) => {
      if (!isBinary || !Buffer.isBuffer(data)) {
        ws.close(CloseCode.InvalidMessage, "binary messages only");
        return;
      }
      joined.receive(peer, data);
    });
    ws.on("close", () => {
      joined.leave(peer);
      if (joined.size === 0 && rooms.get(boardId) === joined) {
        joined.destroy();
        rooms.delete(boardId);
      }
    });
    joined.join(peer, role);
  }

  // A browser that vanished (lid closed, network gone) sends no close frame.
  // Pings find it; the dropped connection then leaves its room.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.pingIntervalMs ?? 30_000);
  pinger.unref();

  return {
    rooms,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          resolve(http.address() as AddressInfo);
        });
      });
    },
    async close() {
      clearInterval(pinger);
      for (const client of wss.clients) client.close(1001, "server shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      for (const room of rooms.values()) room.destroy();
      rooms.clear();
      if (!http.listening) return;
      await new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

function pathname(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}
