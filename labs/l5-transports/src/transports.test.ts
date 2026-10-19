import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChatClient,
  openConnectHttp1,
  openConnectHttp2,
  openGrpcJs,
  openSse,
  openWebSocket,
  openWebTransport,
} from "./clients";
import { ChatHub } from "./hub";
import { type Servers, startServers } from "./server";

let servers: Servers;
const hub = new ChatHub();

beforeAll(async () => {
  servers = await startServers(hub);
});
afterAll(() => servers.close());

type Open = (name: string) => Promise<ChatClient>;

const transports: Record<string, () => Open | null> = {
  WebSocket: () => (name) => openWebSocket(servers.http1, name),
  "Server-sent events": () => (name) => openSse(servers.http1, name),
  "Connect, HTTP/1.1": () => (name) => openConnectHttp1(servers.http1, name),
  "Connect, HTTP/2": () => (name) => openConnectHttp2(servers.http2, name),
  "gRPC (Connect client)": () => (name) => openConnectHttp2(servers.http2, name, "grpc"),
  "gRPC (grpc-js client)": () => (name) => openGrpcJs(servers.http2, name),
  WebTransport: () => {
    const wt = servers.webtransport;
    return wt && ((name) => openWebTransport(wt.url, wt.certificateHash, name));
  },
};

/** Reads the next `count` messages. */
async function take(client: ChatClient, count: number) {
  const messages = [];
  for (let i = 0; i < count; i++) messages.push(await client.next());
  return messages;
}

it("has WebTransport where CI runs", () => {
  // The QUIC library is prebuilt for Linux, macOS and Windows on x64; CI must not lose it quietly.
  if (process.env.CI) expect(servers.webtransport).not.toBeNull();
});

describe.each(Object.entries(transports))("%s", (_name, transport) => {
  it("delivers posts, in order, to everyone including the sender", async (context) => {
    const open = transport();
    if (!open) return context.skip("the QUIC library isn't installed here");
    const alice = await open("alice");
    const bob = await open("bob");
    try {
      await alice.send("one");
      await alice.send("two, with ✨ and\nnewlines");
      // Bob answers once he has seen both. Sending "at the same time" from two
      // connections has no order: `send` resolving means the post left (or
      // was only queued, on a streaming request), not that it arrived.
      const bobSaw = await take(bob, 2);
      await bob.send("three");
      const aliceSaw = await take(alice, 3);
      const got = [...bobSaw, ...(await take(bob, 1))];
      for (const messages of [aliceSaw, got]) {
        expect(messages.map((m) => [m.from, m.text])).toEqual([
          ["alice", "one"],
          ["alice", "two, with ✨ and\nnewlines"],
          ["bob", "three"],
        ]);
      }
      expect(aliceSaw.map((m) => m.id)).toEqual(got.map((m) => m.id));
    } finally {
      alice.close();
      bob.close();
    }
  });
});

it("puts every transport in one room, in one order", async () => {
  const clients: ChatClient[] = [];
  for (const [name, transport] of Object.entries(transports)) {
    const open = transport();
    if (open) clients.push(await open(name));
  }
  try {
    for (const [i, client] of clients.entries()) await client.send(`hello from ${i}`);
    const seen = await Promise.all(clients.map((c) => take(c, clients.length)));
    const first = seen[0]?.map((m) => m.id);
    for (const messages of seen) expect(messages.map((m) => m.id)).toEqual(first);
    expect(new Set(seen[0]?.map((m) => m.text)).size).toBe(clients.length);
  } finally {
    for (const client of clients) client.close();
  }
});
