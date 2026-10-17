import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRealtimeServer, PROTOCOL_VERSION, type RealtimeServer } from "./server.js";

let server: RealtimeServer;
let base: string;

beforeEach(async () => {
  server = createRealtimeServer();
  const { port } = await server.listen(0, "127.0.0.1");
  base = `127.0.0.1:${port}`;
});

afterEach(async () => {
  await server.close();
});

function connect(path: string): WebSocket {
  return new WebSocket(`ws://${base}${path}`);
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
    ws.once("error", reject);
  });
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

describe("WebSocket", () => {
  it("greets clients on /ws with the protocol version", async () => {
    const ws = connect("/ws?board=demo");
    expect(await nextMessage(ws)).toEqual({ type: "hello", protocol: PROTOCOL_VERSION });
    ws.close();
  });

  it("rejects upgrades on other paths", async () => {
    const ws = connect("/elsewhere");
    const status = await new Promise<number | undefined>((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.once("error", () => resolve(undefined));
    });
    expect(status).toBe(404);
  });

  it("closes clients with 1001 when the server shuts down", async () => {
    const ws = connect("/ws");
    await nextMessage(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

    await server.close();
    server = createRealtimeServer(); // afterEach closes a fresh, unstarted server

    expect(await closed).toBe(1001);
  });
});
