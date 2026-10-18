import {
  createServer as createHttp1Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttp2Server, type Http2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import type { ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { WebSocketServer } from "ws";
import { ChatService } from "./gen/chat_pb";
import { type ChatHub, type ChatMessage, hello, messagesOf } from "./hub";
import { formatEvent } from "./sse";
import { startWebTransport, type WebTransportServer } from "./webtransport-server";

/**
 * One chat room on every transport at once:
 *
 * - HTTP/1.1 (`http1`): WebSocket at `/ws`; server-sent events at
 *   `/events`, with posts to `/send`; and Connect's `Send` and `Watch`,
 *   which work over HTTP/1.1.
 * - HTTP/2 without TLS (`http2`): the same Connect service, which also
 *   speaks gRPC and gRPC-Web, so `Talk` (both ways on one stream) works and
 *   a plain gRPC client can call it.
 * - HTTP/3 (`webtransport`, UDP): a WebTransport session at `/chat`, when
 *   the QUIC library is installed.
 */
export interface Servers {
  readonly http1: string;
  readonly http2: string;
  readonly webtransport: WebTransportServer | null;
  close(): Promise<void>;
}

export async function startServers(hub: ChatHub): Promise<Servers> {
  const connect = connectNodeAdapter({ routes: chatRoutes(hub) });

  const http1 = createHttp1Server((req, res) => {
    if (req.url === "/events" && req.method === "GET") return serveEvents(hub, req, res);
    if (req.url === "/send" && req.method === "POST") return void servePost(hub, req, res);
    connect(req, res);
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  http1.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const stop = hub.listen((message) => ws.send(JSON.stringify(message)));
      ws.send(JSON.stringify(hello(hub)));
      ws.on("message", (data) => {
        const post = parsePost(String(data));
        if (post) hub.post(post.from, post.text);
      });
      ws.on("close", stop);
    });
  });

  const http2 = createHttp2Server(connect);
  // An HTTP/2 connection outlives its requests; close needs to end them.
  const sessions = new Set<Http2Session>();
  http2.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  const webtransport = await startWebTransport(hub);

  await Promise.all([listen(http1), listen(http2)]);
  const url = (server: { address(): AddressInfo | string | null }) =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    http1: url(http1),
    http2: url(http2),
    webtransport,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      http1.closeAllConnections();
      for (const session of sessions) session.destroy();
      await Promise.all([
        new Promise((resolve) => http1.close(resolve)),
        new Promise((resolve) => http2.close(resolve)),
        webtransport?.close(),
      ]);
    },
  };
}

function listen(server: { listen(port: number, host: string, done: () => void): unknown }) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

/** The Connect service; Connect also serves it as gRPC and gRPC-Web. */
function chatRoutes(hub: ChatHub) {
  const toProto = (m: ChatMessage) => ({
    id: BigInt(m.id),
    from: m.from,
    text: m.text,
    sentAtMs: BigInt(m.sentAt),
  });
  return (router: ConnectRouter) =>
    router.service(ChatService, {
      async *talk(posts, context) {
        const messages = messagesOf(hub, context.signal);
        // Read posts while writing messages: the two directions are independent.
        void (async () => {
          for await (const post of posts) hub.post(post.from, post.text);
        })().catch(() => {});
        yield toProto(hello(hub));
        for await (const message of messages) yield toProto(message);
      },
      async send(post) {
        return { id: BigInt(hub.post(post.from, post.text).id) };
      },
      async *watch(_request, context) {
        const messages = messagesOf(hub, context.signal);
        yield toProto(hello(hub));
        for await (const message of messages) yield toProto(message);
      },
    });
}

/**
 * Server-sent events: an ordinary response that never ends. Proxies that
 * buffer responses break it, so it says not to cache or transform, and a
 * comment every 15 s keeps idle connections from timing out.
 */
function serveEvents(hub: ChatHub, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  const send = (m: ChatMessage) => res.write(formatEvent(JSON.stringify(m), m.id));
  const stop = hub.listen(send);
  send(hello(hub));
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    stop();
    clearInterval(keepAlive);
  });
}

async function servePost(hub: ChatHub, req: IncomingMessage, res: ServerResponse) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) return void res.writeHead(413).end();
  }
  const post = parsePost(body);
  if (!post) return void res.writeHead(400).end();
  const { id } = hub.post(post.from, post.text);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id }));
}

/** A post as JSON, `{from, text}`, or null if it isn't one. */
export function parsePost(json: string): { from: string; text: string } | null {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return null;
    const { from, text } = value as Record<string, unknown>;
    return typeof from === "string" && typeof text === "string" ? { from, text } : null;
  } catch {
    return null;
  }
}
