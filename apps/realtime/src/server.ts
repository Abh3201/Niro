import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

/** Largest single WebSocket message accepted, in bytes (PLAN.md, section 4). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Version of the wire protocol, sent to every client on connect. */
export const PROTOCOL_VERSION = 0;

export interface RealtimeServer {
  listen(port: number, host?: string): Promise<AddressInfo>;
  /** Closes every client with code 1001 ("going away"), then stops listening. */
  close(): Promise<void>;
}

export function createRealtimeServer(): RealtimeServer {
  const http = createServer((req, res) => {
    if (req.method === "GET" && pathname(req) === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  http.on("upgrade", (req, socket, head) => {
    if (pathname(req) !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    // P0 stub: greet the client and keep the connection open.
    // Rooms, auth on upgrade and Yjs sync arrive in P3a.
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION }));
  });

  return {
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
      for (const client of wss.clients) client.close(1001, "server shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
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
