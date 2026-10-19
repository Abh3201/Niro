/**
 * Runs the real Room and SyncClient on the simulated network from
 * `@niro/netsim`, for tests. Not exported from the package.
 */
import { type Connection, Network, Simulation } from "@niro/netsim";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { SyncClient, type SyncClientOptions } from "./client";
import { type Peer, type Role, Room } from "./room";
import type { Socket } from "./socket";

export const SERVER = "server";

/** A simulated connection, as the client's `Socket`. */
export function socketOf(connection: Connection): Socket {
  const socket: Socket = {
    send: (data) => connection.send(data),
    close: () => connection.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  connection.onopen = () => socket.onopen?.();
  connection.onmessage = (data) =>
    socket.onmessage?.(typeof data === "string" ? new TextEncoder().encode(data) : data);
  connection.onclose = () => socket.onclose?.(1006);
  return socket;
}

/** Viewers are the nodes whose name starts with "view", so the server needs no tokens here. */
export const roleOf = (node: string): Role => (node.startsWith("view") ? "view" : "edit");

/** The realtime server on the simulated network. A crash loses its room: P3a has no storage. */
export class SimServer {
  room = new Room();
  up = true;

  constructor(private readonly net: Network) {
    this.listen();
  }

  crash(): void {
    if (!this.up) return;
    this.up = false;
    this.net.crash(SERVER);
    this.room.destroy();
  }

  restart(): void {
    if (this.up) return;
    this.up = true;
    this.room = new Room();
    this.listen();
  }

  private listen(): void {
    this.net.listen(SERVER, (connection) => {
      const room = this.room;
      const peer: Peer = {
        send: (data) => connection.send(data),
        close: () => connection.close(),
      };
      room.join(peer, roleOf(connection.remote));
      connection.onmessage = (data) =>
        room.receive(peer, typeof data === "string" ? new TextEncoder().encode(data) : data);
      connection.onclose = () => room.leave(peer);
    });
  }
}

export interface SimClient {
  readonly name: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly client: SyncClient;
  destroy(): void;
}

/** A simulated world: one server and the clients you add. */
export class World {
  readonly sim: Simulation;
  readonly net: Network;
  readonly server: SimServer;
  // Fixed client ids keep a seed's run identical; Yjs would pick random ones,
  // and concurrent edits are ordered by client id.
  private nextClientId = 1;

  constructor(seed: number, latency: readonly [number, number] = [5, 50]) {
    this.sim = new Simulation(seed);
    this.net = new Network(this.sim, { latency });
    this.server = new SimServer(this.net);
  }

  /** A browser tab: a doc, its presence, and a SyncClient. */
  client(name: string, options: { restore?: Uint8Array; heartbeatMs?: number } = {}): SimClient {
    const { sim, net } = this;
    const doc = new Y.Doc();
    doc.clientID = this.nextClientId++;
    if (options.restore) Y.applyUpdate(doc, options.restore);
    const awareness = new Awareness(doc);
    awareness.setLocalState({ name });
    const syncOptions: SyncClientOptions = {
      doc,
      awareness,
      connect: () => socketOf(net.connect(name, SERVER)),
      schedule: (delay, fn) => sim.schedule(delay, fn),
      random: () => sim.random.next(),
      heartbeatMs: options.heartbeatMs ?? 0,
    };
    const client = new SyncClient(syncOptions);
    return {
      name,
      doc,
      awareness,
      client,
      destroy() {
        client.destroy();
        awareness.destroy();
        doc.destroy();
      },
    };
  }
}

/** Everything a doc holds that the tests write, as one comparable string. */
export function contentOf(doc: Y.Doc): string {
  // Sorted: each peer's map keeps keys in the order it happened to receive them.
  const m = Object.fromEntries(
    Object.entries(doc.getMap("m").toJSON()).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return JSON.stringify({ m, t: doc.getText("t").toString() });
}

/** Awareness client ids with a state, sorted. */
export function presentIn(awareness: Awareness): number[] {
  return [...awareness.getStates().keys()].sort((a, b) => a - b);
}
