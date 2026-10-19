import { it } from "vitest";
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
import { type Counter, tcpCounter, udpCounter } from "./proxy";
import { startServers } from "./server";

/**
 * Not a test: the numbers in docs/learning/L5-transports.md. Run with
 * `L5_MEASURE=1 pnpm vitest run labs/l5-transports/src/measure.test.ts`.
 *
 * For each transport, one client through a byte-counting relay: how many
 * bytes it takes to connect, then the time and bytes for each of 500 posts,
 * one at a time (send, then wait for it to come back).
 */
const ROUNDS = 500;
const TEXT = "hello, room"; // 11 bytes; the JSON or protobuf around it is the transport's cost

it.runIf(process.env.L5_MEASURE)("measure the transports", { timeout: 120_000 }, async () => {
  const hub = new ChatHub();
  const servers = await startServers(hub);
  const tcp = (url: string) => tcpCounter(url);
  const cases: [string, () => Promise<Counter>, (c: Counter) => Promise<ChatClient>][] = [
    ["WebSocket", () => tcp(servers.http1), (c) => openWebSocket(c.url, "me")],
    ["Server-sent events + POST", () => tcp(servers.http1), (c) => openSse(c.url, "me")],
    ["Connect, HTTP/1.1", () => tcp(servers.http1), (c) => openConnectHttp1(c.url, "me")],
    ["Connect, HTTP/2", () => tcp(servers.http2), (c) => openConnectHttp2(c.url, "me")],
    [
      "gRPC (Connect client)",
      () => tcp(servers.http2),
      (c) => openConnectHttp2(c.url, "me", "grpc"),
    ],
    ["gRPC (grpc-js client)", () => tcp(servers.http2), (c) => openGrpcJs(c.url, "me")],
  ];
  const wt = servers.webtransport;
  if (wt) {
    cases.push([
      "WebTransport (HTTP/3)",
      () => udpCounter(wt.url),
      (c) => openWebTransport(c.url, wt.certificateHash, "me"),
    ]);
  }

  const rows: string[] = [];
  for (const [name, relay, open] of cases) {
    const counter = await relay();
    const client = await open(counter);
    const connect = counter.up + counter.down;
    // Warm up (JIT, connection pools), then measure.
    for (let i = 0; i < 50; i++) await roundTrip(client);
    const up = counter.up;
    const down = counter.down;
    const times: number[] = [];
    for (let i = 0; i < ROUNDS; i++) times.push(await roundTrip(client));
    const perUp = (counter.up - up) / ROUNDS;
    const perDown = (counter.down - down) / ROUNDS;
    client.close();
    await counter.close();
    times.sort((a, b) => a - b);
    const at = (q: number) => (times[Math.floor(q * (times.length - 1))] ?? 0).toFixed(2);
    rows.push(
      `| ${name} | ${connect} | ${perUp.toFixed(0)} | ${perDown.toFixed(0)} | ${at(0.5)} | ${at(0.99)} |`,
    );
  }
  await servers.close();
  console.log(
    [
      "| Transport | Bytes to connect | Bytes up per post | Bytes down per post | Round trip p50 (ms) | p99 (ms) |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n"),
  );
});

async function roundTrip(client: ChatClient): Promise<number> {
  const start = performance.now();
  await client.send(TEXT);
  await client.next();
  return performance.now() - start;
}
