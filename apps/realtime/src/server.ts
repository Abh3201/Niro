import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import { countShapes } from "@niro/doc/yjs";
import {
  BOARD_ID,
  type BoardStorage,
  CloseCode,
  isSyncStep2,
  type Lease,
  MemoryStorage,
  type Peer,
  PROTOCOL_VERSION,
  type Role,
  type Room,
  RoomHost,
} from "@niro/sync";
import { verifyToken } from "@niro/sync/auth";
import { type WebSocket, WebSocketServer } from "ws";
import type * as Y from "yjs";
import { type AssetStorage, assetId, IMAGE_TYPES, MemoryAssets, sniffImageType } from "./assets";
import { CONTENT_TYPE, Counter, Histogram, Registry, Sampled } from "./metrics";
import { TokenBucket } from "./rate";

/** Queued bytes above which a connection's cursor updates are skipped. */
const SOFT_BUFFER_BYTES = 256 * 1024;
/**
 * Queued bytes above which a connection is dropped. A client that far behind
 * catches up faster by reconnecting: the sync handshake sends only what it's
 * missing, once, instead of every intermediate update.
 */
const HARD_BUFFER_BYTES = 8 * 1024 * 1024;
/** How long a connection waits for its board to load before it's refused. */
const LOAD_TIMEOUT_MS = 10_000;

/** Starting values from the plan, not measured yet: `/metrics` is how to tune them. */
export interface Limits {
  /** Largest message, except a connection's first catch-up (sync step 2). */
  messageBytes: number;
  /**
   * About the largest a board gets before it turns read-only, as stored. A
   * catch-up message may be up to twice this: a client can hold a board
   * slightly over the limit, and it may have to send all of it after the
   * server lost data. In memory a board takes about 25 times its stored
   * size (measured with sticky notes: 1,000 of them are 0.28 MB stored and
   * 8 MB in memory, 10,000 are 3 MB and 67 MB), so 5 MB is about 125 MB.
   */
  documentBytes: number;
  /** Shapes on a board before it turns read-only. */
  shapes: number;
  /** Connections to one board. */
  connectionsPerRoom: number;
  /**
   * Stored size of all open boards together. Past it, boards nobody has open
   * are turned away until some close; open ones keep working. This is the
   * server's memory budget: about 25 times this, see `documentBytes`.
   * Checked before a board loads, so boards loading at that moment can take
   * it over by their own size.
   */
  openBytes: number;
  /** Connections to the whole server. */
  connections: number;
  /** Messages a connection may send per second, sustained. Bursts of twice that pass. */
  messagesPerSecond: number;
  /** Bytes a connection may send per second, sustained. Bursts of four times that pass. */
  bytesPerSecond: number;
  /** Largest image file. Browsers shrink big pictures before uploading, so few come near it. */
  imageBytes: number;
  /** All of one board's image files together. */
  boardImageBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  messageBytes: 1024 * 1024,
  documentBytes: 5 * 1024 * 1024,
  shapes: 10_000,
  connectionsPerRoom: 100,
  // About 1 GB of memory.
  openBytes: 40 * 1024 * 1024,
  connections: 2_000,
  messagesPerSecond: 200,
  bytesPerSecond: 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  boardImageBytes: 50 * 1024 * 1024,
};

export interface RealtimeServerOptions {
  /** Signs access tokens; shared with the web app (`NIRO_SECRET`). */
  secret: string;
  /** Where boards are kept between sessions. Default: in memory, lost on restart. */
  storage?: BoardStorage;
  /** Where images are kept. Default: in memory, lost on restart. */
  assets?: AssetStorage;
  limits?: Partial<Limits>;
  /** When set, `/metrics` needs `Authorization: Bearer <token>`. */
  metricsToken?: string;
  /** Pings every connection this often and drops those that missed the last ping. */
  pingIntervalMs?: number;
  /** Failures that belong to no one connection: storage, mostly. Default: console.error. */
  log?: (message: string, error: unknown) => void;
}

export interface RealtimeServer {
  listen(port: number, host?: string): Promise<AddressInfo>;
  /**
   * Refuses new connections, closes every client with 1001 ("going away"),
   * writes every board, then stops listening. Doesn't close the storage.
   */
  close(): Promise<void>;
  /** Boards with someone connected, or still being written. */
  readonly rooms: ReadonlyMap<string, Room>;
}

/**
 * The realtime server: one `Room` per open board, loaded from storage when
 * the first person connects and written back as people edit (`RoomHost`).
 */
export function createRealtimeServer(options: RealtimeServerOptions): RealtimeServer {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const log = options.log ?? ((message, error) => console.error(message, error));
  const alive = new WeakMap<WebSocket, boolean>();
  /** Connections per board, counted from before the board loads so a crowd can't race past the limit. */
  const connections = new Map<string, number>();
  /** Every board's count in `connections`, added up. */
  let connectionCount = 0;
  let closing = false;

  const registry = new Registry();
  const metrics = {
    opened: registry.add(
      new Counter("niro_connections_opened_total", "WebSocket connections accepted."),
    ),
    rejected: registry.add(
      new Counter(
        "niro_connections_rejected_total",
        "Upgrade requests refused, by reason.",
        [
          "not_found",
          "bad_request",
          "unauthorized",
          "shutting_down",
          "room_full",
          "server_full",
          "unavailable",
        ].map((reason) => ({ reason })),
      ),
    ),
    dropped: registry.add(
      new Counter(
        "niro_connections_dropped_total",
        "Connections the server closed, by reason.",
        ["invalid", "too_big", "rate_limited", "too_slow", "unresponsive"].map((reason) => ({
          reason,
        })),
      ),
    ),
    messagesIn: registry.add(new Counter("niro_messages_received_total", "Messages from clients.")),
    bytesIn: registry.add(
      new Counter("niro_received_bytes_total", "Bytes of messages from clients."),
    ),
    messagesOut: registry.add(new Counter("niro_messages_sent_total", "Messages to clients.")),
    bytesOut: registry.add(new Counter("niro_sent_bytes_total", "Bytes of messages to clients.")),
    flushes: registry.add(
      new Counter("niro_flushes_total", "Writes to storage, by kind.", [
        { kind: "append" },
        { kind: "snapshot" },
      ]),
    ),
    storageErrors: registry.add(
      new Counter("niro_storage_errors_total", "Failed loads and writes. Writes are retried."),
    ),
    flushSeconds: registry.add(
      new Histogram(
        "niro_flush_duration_seconds",
        "How long writes to storage take.",
        [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      ),
    ),
    images: registry.add(
      new Counter(
        "niro_image_uploads_total",
        "Image uploads, by outcome.",
        ["stored", "exists", "full", "refused"].map((outcome) => ({ outcome })),
      ),
    ),
    documentBytes: registry.add(
      new Histogram(
        "niro_document_bytes",
        "Board size at each write (an upper bound between compactions).",
        [1e3, 1e4, 1e5, 1e6, 5e6, 1e7, 2e7, 5e7],
      ),
    ),
  };

  const shapeCounts = new WeakMap<Y.Doc, { readonly count: number }>();
  const host = new RoomHost({
    storage: options.storage ?? new MemoryStorage(),
    maxDocumentBytes: limits.documentBytes,
    isFull(doc) {
      let counter = shapeCounts.get(doc);
      if (!counter) {
        // Called first right after the board loads, then after every change.
        counter = countShapes(doc);
        shapeCounts.set(doc, counter);
      }
      return counter.count >= limits.shapes;
    },
    onFlush(info) {
      metrics.flushes.inc({ kind: info.compacted ? "snapshot" : "append" });
      metrics.flushSeconds.observe(info.durationMs / 1000);
      metrics.documentBytes.observe(info.documentBytes);
    },
    onError(error, boardId) {
      metrics.storageErrors.inc();
      log(`storage failed for board ${boardId}; will retry`, error);
    },
  });

  registry.add(
    new Sampled(
      "niro_connections",
      "gauge",
      "Open WebSocket connections.",
      () => editors.clients.size + viewers.clients.size,
    ),
  );
  registry.add(new Sampled("niro_rooms", "gauge", "Boards open in memory.", () => host.rooms.size));
  registry.add(
    new Sampled(
      "niro_open_board_bytes",
      "gauge",
      "Stored size of the open boards, an upper bound (see NIRO_MAX_OPEN_MB).",
      () => host.openBytes,
    ),
  );
  registry.add(
    new Sampled("niro_rooms_read_only", "gauge", "Open boards that reached a limit.", () => {
      let count = 0;
      for (const room of host.rooms.values()) if (room.readOnly !== null) count++;
      return count;
    }),
  );
  registry.add(
    new Sampled(
      "niro_unwritten_changes",
      "gauge",
      "Changes not in storage yet.",
      () => host.unwritten,
    ),
  );
  registry.add(
    new Sampled("niro_updates_applied_total", "counter", "Document updates applied.", () => {
      return host.stats.updatesApplied;
    }),
  );
  registry.add(
    new Sampled(
      "niro_updates_refused_total",
      "counter",
      "Document updates refused: from viewers, or to read-only boards.",
      () => host.stats.updatesRefused,
    ),
  );

  const assets = options.assets ?? new MemoryAssets();
  const assetRoutes = assetHandler(assets, options.secret, limits, (outcome) =>
    metrics.images.inc({ outcome }),
  );

  const http = createServer((req, res) => {
    const path = pathname(req);
    if (path?.startsWith("/assets/")) {
      assetRoutes(req, res, path).catch((error: unknown) => {
        log("image request failed", error);
        if (!res.headersSent) res.writeHead(500, CORS);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && path === "/metrics") {
      if (options.metricsToken && !bearerMatches(req, options.metricsToken)) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      res.writeHead(200, { "content-type": CONTENT_TYPE });
      res.end(registry.render());
      return;
    }
    res.writeHead(404).end();
  });

  // Two servers, because ws checks a message's size only against its server's
  // `maxPayload`, and buffers the whole message before anyone else sees it.
  // Editors may send a whole board once, as their catch-up. Viewers' changes
  // are refused anyway, so nothing they send needs to be bigger than a live
  // message: past that, ws closes them before buffering more.
  const editors = new WebSocketServer({ noServer: true, maxPayload: limits.documentBytes * 2 });
  const viewers = new WebSocketServer({ noServer: true, maxPayload: limits.messageBytes });
  const clients = () => [...editors.clients, ...viewers.clients];

  // Checked before the upgrade, so a refused client costs one HTTP response.
  // Browsers can't read the status, so the client learns of a bad link from
  // the web app's token endpoint, not from here.
  http.on("upgrade", (req: IncomingMessage, socket: NetSocket, head: Buffer) => {
    // Until ws takes the socket over, nothing else listens for its errors (a
    // client resetting the connection while its board loads), and an
    // unheard error would crash the process.
    socket.on("error", () => socket.destroy());
    const refuse = (status: string, reason: string) => {
      metrics.rejected.inc({ reason });
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    const url = requestUrl(req);
    if (url?.pathname !== "/ws") return refuse("404 Not Found", "not_found");
    if (url.searchParams.get("v") !== String(PROTOCOL_VERSION))
      return refuse("400 Bad Request", "bad_request");
    const boardId = url.searchParams.get("board") ?? "";
    if (!BOARD_ID.test(boardId)) return refuse("400 Bad Request", "bad_request");
    const grant = verifyToken(options.secret, url.searchParams.get("token") ?? "");
    if (!grant || grant.boardId !== boardId) return refuse("401 Unauthorized", "unauthorized");
    if (closing) return refuse("503 Service Unavailable", "shutting_down");
    const count = connections.get(boardId) ?? 0;
    if (count >= limits.connectionsPerRoom) return refuse("503 Service Unavailable", "room_full");
    if (connectionCount >= limits.connections)
      return refuse("503 Service Unavailable", "server_full");
    if (!host.isOpen(boardId) && host.openBytes >= limits.openBytes)
      return refuse("503 Service Unavailable", "server_full");

    connections.set(boardId, count + 1);
    connectionCount++;
    const unreserve = () => {
      connectionCount--;
      const left = (connections.get(boardId) ?? 1) - 1;
      if (left > 0) connections.set(boardId, left);
      else connections.delete(boardId);
    };
    acquireWithin(host, boardId, LOAD_TIMEOUT_MS)
      .then(
        (lease) => {
          if (socket.destroyed || closing) {
            // The client gave up while the board loaded, or the server is stopping.
            lease.release();
            unreserve();
            if (!socket.destroyed) refuse("503 Service Unavailable", "shutting_down");
            return;
          }
          // ws answers a malformed upgrade itself and never calls back; the
          // socket closing is then the only sign, and the lease must go back.
          let upgraded = false;
          const abandoned = () => {
            if (upgraded) return;
            lease.release();
            unreserve();
          };
          socket.once("close", abandoned);
          const wss = grant.role === "edit" ? editors : viewers;
          wss.handleUpgrade(req, socket, head, (ws) => {
            upgraded = true;
            socket.off("close", abandoned);
            connect(ws, lease, grant.role, unreserve);
          });
        },
        (error: unknown) => {
          unreserve();
          metrics.storageErrors.inc();
          log(`could not load board ${boardId}`, error);
          refuse("503 Service Unavailable", "unavailable");
        },
      )
      .catch((error: unknown) => log("upgrade failed", error));
  });

  function connect(ws: WebSocket, lease: Lease, role: Role, unreserve: () => void): void {
    const room = lease.room;
    const messages = new TokenBucket(limits.messagesPerSecond, limits.messagesPerSecond * 2);
    const bytes = new TokenBucket(limits.bytesPerSecond, limits.bytesPerSecond * 4);
    let caughtUp = false;
    let dropping = false;
    metrics.opened.inc();

    const drop = (reason: string, code: number, message: string) => {
      if (dropping) return;
      dropping = true;
      metrics.dropped.inc({ reason });
      ws.close(code, message);
    };
    const peer: Peer = {
      send(data, droppable) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > HARD_BUFFER_BYTES) {
          metrics.dropped.inc({ reason: "too_slow" });
          ws.terminate();
          return;
        }
        if (droppable && ws.bufferedAmount > SOFT_BUFFER_BYTES) return;
        metrics.messagesOut.inc();
        metrics.bytesOut.inc({}, data.length);
        ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    // A protocol error (a message over `maxPayload`, a bad frame): ws closes
    // the connection itself. Without a listener, the error would crash the process.
    ws.on("error", () => {});
    ws.on("message", (data, isBinary) => {
      if (dropping) return;
      if (!isBinary || !Buffer.isBuffer(data)) {
        drop("invalid", CloseCode.InvalidMessage, "binary messages only");
        return;
      }
      metrics.messagesIn.inc();
      metrics.bytesIn.inc({}, data.length);
      // An editor's first catch-up can be the whole board: it's exempt from
      // the size and rate limits. Everything after it is a live change, or
      // cursors. A viewer's catch-up would be refused, so it gets no exemption.
      if (!caughtUp && role === "edit" && isSyncStep2(data)) {
        caughtUp = true;
      } else if (data.length > limits.messageBytes) {
        // The client reconnects and sends it again as part of its catch-up.
        drop("too_big", CloseCode.TooBig, "message too big");
        return;
      } else if (!messages.take() || !bytes.take(data.length)) {
        drop("rate_limited", CloseCode.RateLimited, "too many messages");
        return;
      }
      room.receive(peer, data);
    });
    ws.on("close", () => {
      room.leave(peer);
      lease.release();
      unreserve();
    });
    room.join(peer, role);
  }

  // A browser that vanished (lid closed, network gone) sends no close frame.
  // Pings find it; the dropped connection then leaves its room.
  const pinger = setInterval(() => {
    for (const ws of clients()) {
      if (!alive.get(ws)) {
        metrics.dropped.inc({ reason: "unresponsive" });
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.pingIntervalMs ?? 30_000);
  pinger.unref();

  return {
    get rooms() {
      return host.rooms;
    },
    listen(port, hostname) {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, hostname, () => {
          http.off("error", reject);
          resolve(http.address() as AddressInfo);
        });
      });
    },
    async close() {
      closing = true;
      clearInterval(pinger);
      for (const client of clients()) client.close(1001, "server shutting down");
      await Promise.all(
        [editors, viewers].map((wss) => new Promise<void>((resolve) => wss.close(() => resolve()))),
      );
      await host.close();
      if (!http.listening) return;
      await new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/** `host.acquire`, refused after `ms`. A lease that arrives later is given straight back. */
function acquireWithin(host: RoomHost, boardId: string, ms: number): Promise<Lease> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`loading took over ${ms} ms`));
    }, ms);
    host.acquire(boardId).then(
      (lease) => {
        clearTimeout(timer);
        if (timedOut) lease.release();
        else resolve(lease);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Any page may call the image routes: they take a token in a header, never
 * a cookie, so another site gets nothing a link didn't already give it.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
} as const;

const ASSET_PATH = /^\/assets\/([A-Za-z0-9_-]+)(?:\/([0-9a-f]{64}))?$/;

/**
 * `POST /assets/<board>` with an image as the body stores it and answers
 * `{id}`; `GET /assets/<board>/<id>` returns it. Both take the board's
 * 60-second token as `Authorization: Bearer <token>`: posting needs an edit
 * token, reading any token for that board.
 */
function assetHandler(
  assets: AssetStorage,
  secret: string,
  limits: Limits,
  counted: (outcome: "stored" | "exists" | "full" | "refused") => void,
) {
  const answer = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, {
      ...CORS,
      "cache-control": "no-store",
      ...(body !== undefined && { "content-type": "application/json" }),
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }
    const match = ASSET_PATH.exec(path);
    const boardId = match?.[1] ?? "";
    const id = match?.[2];
    if (!match || !BOARD_ID.test(boardId)) return answer(res, 404);
    const header = req.headers.authorization ?? "";
    const grant = header.startsWith("Bearer ") ? verifyToken(secret, header.slice(7)) : null;
    if (!grant || grant.boardId !== boardId) return answer(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && id) {
      const asset = await assets.get(boardId, id);
      if (!asset) return answer(res, 404);
      res.writeHead(200, {
        ...CORS,
        "content-type": asset.type,
        "content-length": asset.data.byteLength,
        // The id is the content's hash, so it never changes.
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      });
      res.end(asset.data);
      return;
    }
    if (req.method !== "POST" || id) return answer(res, 405);
    if (grant.role !== "edit") return answer(res, 403, { error: "view only" });
    const declared = (req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    if (!Object.hasOwn(IMAGE_TYPES, declared)) {
      counted("refused");
      return answer(res, 415, { error: "unsupported type" });
    }
    const length = Number(req.headers["content-length"]);
    if (Number.isFinite(length) && length > limits.imageBytes) {
      counted("refused");
      req.resume();
      return answer(res, 413, { error: "too big" });
    }
    const data = await readBody(req, limits.imageBytes);
    if (!data) {
      counted("refused");
      return answer(res, 413, { error: "too big" });
    }
    const type = sniffImageType(data);
    if (type === null || type !== declared) {
      counted("refused");
      return answer(res, 415, { error: "not an image of that type" });
    }
    const assetKey = assetId(data);
    const result = await assets.put(boardId, assetKey, { type, data }, limits.boardImageBytes);
    counted(result);
    if (result === "full") return answer(res, 413, { error: "board full" });
    return answer(res, result === "stored" ? 201 : 200, { id: assetKey });
  };
}

/** The request's body, or null once it passes `max` bytes (the rest is left unread). */
function readBody(req: IncomingMessage, max: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > max) {
        req.off("data", onData);
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (size <= max) resolve(Buffer.concat(chunks));
    });
    // A client that gives up mid-upload: nothing more is coming. (Resolving twice is harmless.)
    req.on("close", () => resolve(null));
    req.on("error", reject);
  });
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The request's URL, or null if it doesn't parse. A request line like
 * `GET //[ HTTP/1.1` passes Node's parser but makes `new URL` throw, and a
 * throw in these handlers would take the whole server down.
 */
function requestUrl(req: IncomingMessage): URL | null {
  return URL.parse(req.url ?? "/", "http://localhost");
}

function pathname(req: IncomingMessage): string | undefined {
  return requestUrl(req)?.pathname;
}
