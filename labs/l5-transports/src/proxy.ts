import { createSocket, type RemoteInfo } from "node:dgram";
import { type AddressInfo, connect, createServer } from "node:net";

/**
 * Relays that count the bytes going through them: TCP for everything on
 * HTTP/1.1 and HTTP/2, UDP for QUIC. Counting at this level includes
 * everything a transport adds: HTTP headers, frames, TLS (none here, for the
 * TCP ones), QUIC's encryption and acknowledgements.
 */
export interface Counter {
  readonly url: string;
  /** Bytes from client to server so far. */
  up: number;
  /** Bytes from server to client so far. */
  down: number;
  close(): Promise<void>;
}

/** Listens on a new port and relays every TCP connection to `target` (an http://host:port URL). */
export async function tcpCounter(target: string): Promise<Counter> {
  const { hostname, port } = new URL(target);
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(port), hostname);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (data) => {
      counter.up += data.length;
      upstream.write(data);
    });
    upstream.on("data", (data) => {
      counter.down += data.length;
      client.write(data);
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const counter: Counter = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    up: 0,
    down: 0,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return counter;
}

/** Relays UDP datagrams from one client to `target` (an https://host:port/path URL) and back. */
export async function udpCounter(target: string): Promise<Counter> {
  const url = new URL(target);
  const front = createSocket("udp4");
  const back = createSocket("udp4");
  let client: RemoteInfo | null = null;
  front.on("message", (data, from) => {
    client = from;
    counter.up += data.length;
    back.send(data, Number(url.port), url.hostname);
  });
  back.on("message", (data) => {
    counter.down += data.length;
    if (client) front.send(data, client.port, client.address);
  });
  await new Promise<void>((resolve) => front.bind(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => back.bind(0, "127.0.0.1", resolve));
  const relayed = new URL(target);
  relayed.port = String(front.address().port);
  const counter: Counter = {
    url: relayed.href,
    up: 0,
    down: 0,
    async close() {
      front.close();
      back.close();
    },
  };
  return counter;
}
