/**
 * Runs the real Room and SyncClient on the simulated network from
 * `@niro/netsim`, for tests. Not exported from the package.
 */
import { type Connection, Network, Simulation } from "@niro/netsim";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { SyncClient, type SyncClientOptions } from "./client";
import { type BoardStorage, type Lease, RoomHost, type RoomHostOptions } from "./host";
import { type Peer, type Role, Room } from "./room";
import type { Socket } from "./socket";

export const SERVER = "server";
/** The one board the simulated server holds. */
export const BOARD = "board-0001";

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

/**
 * A database on the simulated network's clock: every call takes a random
 * few milliseconds, fails while `down`, and dies with the server process
 * that made it (an uncommitted transaction never lands).
 */
export class SimStorage {
  readonly boards = new Map<string, Uint8Array[]>();
  down = false;
  private generation = 0;

  constructor(
    private readonly sim: Simulation,
    private readonly latency: readonly [number, number] = [1, 30],
  ) {}

  /** A connection for one server process. */
  connect(): BoardStorage {
    const generation = this.generation;
    const call = <T>(fn: () => T): Promise<T> =>
      this.sim.later(this.sim.random.int(...this.latency), () => {
        // The process that asked is gone: its call never completes.
        if (generation !== this.generation) return new Promise<T>(() => {});
        if (this.down) throw new Error("storage is down");
        return fn();
      });
    return {
      load: (boardId) => call(() => [...(this.boards.get(boardId) ?? [])]),
      append: (boardId, update) =>
        call(() => {
          this.boards.set(boardId, [...(this.boards.get(boardId) ?? []), update]);
        }),
      replace: (boardId, state) =>
        call(() => {
          this.boards.set(boardId, [state]);
        }),
    };
  }

  /** Every connection made so far dies, as when the server process crashes. */
  disconnectAll(): void {
    this.generation++;
  }

  /** The board as stored, loaded into a fresh doc. */
  stored(boardId: string): Y.Doc {
    const doc = new Y.Doc();
    for (const update of this.boards.get(boardId) ?? []) Y.applyUpdate(doc, update);
    return doc;
  }
}

/**
 * The realtime server with storage, on the simulated network: a `RoomHost`
 * holding one board. A crash loses whatever wasn't written yet.
 *
 * The real server holds the WebSocket upgrade until the room has loaded;
 * here the connection is already open, so messages wait in a queue instead.
 */
export class HostedSimServer {
  host: RoomHost;
  up = true;

  constructor(
    private readonly sim: Simulation,
    private readonly net: Network,
    readonly storage: SimStorage,
    private readonly hostOptions: Partial<RoomHostOptions> = {},
  ) {
    this.host = this.start();
  }

  /** The board's room, while someone has it open. */
  get room(): Room | undefined {
    return this.host.rooms.get(BOARD);
  }

  crash(): void {
    if (!this.up) return;
    this.up = false;
    this.net.crash(SERVER);
    this.storage.disconnectAll();
    for (const room of this.host.rooms.values()) room.destroy();
  }

  restart(): void {
    if (this.up) return;
    this.up = true;
    this.host = this.start();
  }

  private start(): RoomHost {
    const host = new RoomHost({
      storage: this.storage.connect(),
      schedule: (delay, fn) => this.sim.schedule(delay, fn),
      now: () => this.sim.now,
      ...this.hostOptions,
    });
    this.net.listen(SERVER, (connection) => {
      const peer: Peer = {
        send: (data) => connection.send(data),
        close: () => connection.close(),
      };
      const queued: Uint8Array[] = [];
      let lease: Lease | null = null;
      let closed = false;
      connection.onmessage = (data) => {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        if (lease) lease.room.receive(peer, bytes);
        else queued.push(bytes);
      };
      connection.onclose = () => {
        closed = true;
        lease?.room.leave(peer);
        lease?.release();
      };
      host.acquire(BOARD).then(
        (acquired) => {
          if (closed) {
            acquired.release();
            return;
          }
          lease = acquired;
          acquired.room.join(peer, roleOf(connection.remote));
          for (const data of queued.splice(0)) acquired.room.receive(peer, data);
        },
        // Storage is down: refuse, as the real server answers 503. The client retries.
        () => connection.close(),
      );
    });
    return host;
  }
}

export interface SimClient {
  readonly name: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly client: SyncClient;
  destroy(): void;
}

/** A simulated network and the browser tabs you add to it. */
class Clients {
  readonly sim: Simulation;
  readonly net: Network;
  // Fixed client ids keep a seed's run identical; Yjs would pick random ones,
  // and concurrent edits are ordered by client id.
  private nextClientId = 1;

  constructor(seed: number, latency: readonly [number, number]) {
    this.sim = new Simulation(seed);
    this.net = new Network(this.sim, { latency });
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

/** A simulated world: a server that keeps rooms in memory only (P3a), and the tabs you add. */
export class World extends Clients {
  readonly server: SimServer;

  constructor(seed: number, latency: readonly [number, number] = [5, 50]) {
    super(seed, latency);
    this.server = new SimServer(this.net);
  }
}

/**
 * A simulated world with storage: a `RoomHost` on `SimStorage`, and the tabs
 * you add. Hosts await storage, so drive it with the `Async` runners.
 */
export class HostedWorld extends Clients {
  readonly storage: SimStorage;
  readonly server: HostedSimServer;

  constructor(
    seed: number,
    latency: readonly [number, number] = [5, 50],
    hostOptions: Partial<RoomHostOptions> = {},
    storageLatency: readonly [number, number] = [1, 30],
  ) {
    super(seed, latency);
    this.storage = new SimStorage(this.sim, storageLatency);
    this.server = new HostedSimServer(this.sim, this.net, this.storage, hostOptions);
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
