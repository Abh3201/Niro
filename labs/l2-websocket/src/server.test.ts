import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { decodeClose, encodeFrame, type Frame, FrameParser, Opcode } from "./frame";
import { createWebSocketServer, type ServerWebSocket, type WebSocketServerOptions } from "./server";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** An echo server on a random port. */
async function start(options: Partial<WebSocketServerOptions> = {}) {
  const connections: ServerWebSocket[] = [];
  const closes: [number, string][] = [];
  const server = createWebSocketServer({
    ...options,
    onConnection(ws) {
      connections.push(ws);
      ws.onmessage = (data) => ws.send(data);
      ws.onclose = (code, reason) => closes.push([code, reason]);
    },
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => sockets.add(s));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const port = (server.address() as AddressInfo).port;
  return { port, url: `ws://127.0.0.1:${port}/`, connections, closes };
}

async function connect(url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  const ws = new WebSocket(url, options);
  cleanup.push(() => ws.terminate());
  await once(ws, "open");
  return ws;
}

async function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  const [data, isBinary] = (await once(ws, "message")) as [Buffer, boolean];
  return { data, isBinary };
}

async function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  const [code, reason] = (await once(ws, "close")) as [number, Buffer];
  return { code, reason: reason.toString() };
}

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A hand-rolled client on a bare TCP socket, for things the ws client won't do. */
async function rawClient(port: number, afterHandshake: Uint8Array = new Uint8Array(0)) {
  const socket = net.connect(port, "127.0.0.1");
  cleanup.push(() => socket.destroy());
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(socket, "close");
  const key = randomBytes(16).toString("base64");
  const head =
    "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  // One write: the frames ride in the same packet as the request.
  socket.write(Buffer.concat([Buffer.from(head), afterHandshake]));
  return {
    socket,
    ended,
    /** Frames the server sent so far, after its handshake response. */
    frames(): Frame[] {
      const all = Buffer.concat(chunks);
      const body = all.subarray(all.indexOf("\r\n\r\n") + 4);
      return new FrameParser({ maxPayload: 1 << 20, expectMasked: false }).push(body);
    },
  };
}

const mask = () => new Uint8Array(randomBytes(4));
const text = (s: string) => new TextEncoder().encode(s);

describe("L2 WebSocket server, against the ws client", () => {
  it("echoes text, binary, and messages needing 16- and 64-bit lengths", async () => {
    const { url } = await start();
    const ws = await connect(url);

    ws.send("héllo 👋");
    expect(await nextMessage(ws)).toEqual({ data: Buffer.from("héllo 👋"), isBinary: false });

    for (const size of [4, 300, 100_000]) {
      const bytes = randomBytes(size);
      ws.send(bytes);
      const reply = await nextMessage(ws);
      expect(reply.isBinary).toBe(true);
      expect(reply.data.equals(bytes)).toBe(true);
    }
  });

  it("reassembles fragments, with a ping between them", async () => {
    const { url } = await start();
    const ws = await connect(url);
    // Listen first: the pong and the echo can arrive in one packet and fire in one tick.
    const pong = once(ws, "pong");
    const message = nextMessage(ws);
    ws.send("frag", { fin: false });
    ws.ping("mid-message");
    ws.send("mented", { fin: true });
    expect(String((await pong)[0])).toBe("mid-message");
    expect(String((await message).data)).toBe("fragmented");
  });

  it("closes cleanly when the client closes", async () => {
    const { url, closes } = await start();
    const ws = await connect(url);
    ws.close(4000, "bye");
    // The server echoes the code; the reason is for the side that started the close.
    expect(await closed(ws)).toEqual({ code: 4000, reason: "" });
    await waitFor(() => closes.length === 1);
    expect(closes).toEqual([[4000, "bye"]]);
  });

  it("closes cleanly when the server closes", async () => {
    const { url, connections, closes } = await start();
    const ws = await connect(url);
    connections[0]?.close(1001, "going away");
    expect(await closed(ws)).toEqual({ code: 1001, reason: "going away" });
    await waitFor(() => closes.length === 1);
    expect(closes[0]?.[0]).toBe(1001);
  });

  it("closes with 1007 on text that isn't UTF-8", async () => {
    const { url, closes } = await start();
    const ws = await connect(url);
    ws.send(Buffer.from([0xc3, 0x28]), { binary: false });
    expect((await closed(ws)).code).toBe(1007);
    await waitFor(() => closes.length === 1);
    expect(closes[0]?.[0]).toBe(1007);
  });

  it("closes with 1009 when a message is over the limit, even in small frames", async () => {
    const { url } = await start({ maxPayload: 1024 });
    const whole = await connect(url);
    whole.send(randomBytes(2000));
    expect((await closed(whole)).code).toBe(1009);

    const split = await connect(url);
    split.send(randomBytes(600), { fin: false });
    split.send(randomBytes(600), { fin: true });
    expect((await closed(split)).code).toBe(1009);
  });

  it("refuses a connection from an origin it doesn't allow", async () => {
    const { url } = await start({ allowOrigin: (origin) => origin === "https://niro.example" });
    await connect(url, { origin: "https://niro.example" });
    const evil = new WebSocket(url, { origin: "https://evil.example" });
    cleanup.push(() => evil.terminate());
    const [error] = (await once(evil, "error")) as [Error];
    expect(error.message).toContain("403");
  });
});

describe("L2 WebSocket server, on a raw socket", () => {
  it("answers a plain HTTP request with 400", async () => {
    const { port } = await start();
    const socket = net.connect(port, "127.0.0.1");
    cleanup.push(() => socket.destroy());
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const [data] = (await once(socket, "data")) as [Buffer];
    expect(data.toString()).toMatch(/^HTTP\/1\.1 400 /);
  });

  it("reads frames that arrive in the same packet as the handshake", async () => {
    const { port } = await start();
    const client = await rawClient(port, encodeFrame(Opcode.Text, text("early"), { mask: mask() }));
    await waitFor(() => client.frames().length === 1);
    expect(client.frames()[0]).toEqual({ fin: true, opcode: Opcode.Text, payload: text("early") });
  });

  it("closes with 1002 on an unmasked client frame", async () => {
    const { port, closes } = await start();
    const client = await rawClient(port, encodeFrame(Opcode.Text, text("no mask")));
    await client.ended;
    const [frame] = client.frames();
    expect(frame?.opcode).toBe(Opcode.Close);
    expect(decodeClose(frame?.payload ?? new Uint8Array(0)).code).toBe(1002);
    await waitFor(() => closes.length === 1);
    expect(closes[0]?.[0]).toBe(1002);
  });

  it("drops a peer that stops answering pings", async () => {
    const { port, closes } = await start({ heartbeatMs: 30 });
    const client = await rawClient(port);
    await client.ended;
    expect(client.frames().map((f) => f.opcode)).toEqual([Opcode.Ping]);
    await waitFor(() => closes.length === 1);
    expect(closes).toEqual([[1006, ""]]);
  });
});
