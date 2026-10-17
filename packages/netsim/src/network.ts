import type { Simulation } from "./simulation";

export type Payload = string | Uint8Array;

export type ReadyState = "connecting" | "open" | "closed";

/**
 * One end of an ordered, reliable connection, shaped like a browser
 * WebSocket so the same client and server code can run on a real socket or
 * on the simulation.
 */
export interface Connection {
  /** This end's node name. */
  readonly local: string;
  readonly remote: string;
  readonly readyState: ReadyState;
  /** Queued for delivery in order. Silently lost if the connection breaks first. */
  send(data: Payload): void;
  /** Closes gracefully: messages already sent still arrive, then the other end sees `onclose`. */
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: Payload) => void) | null;
  onclose: (() => void) | null;
}

export interface LinkOptions {
  /** One-way delay range in virtual milliseconds. */
  latency: readonly [number, number];
  /** Datagrams only: chance each one is lost. */
  dropRate: number;
  /** Datagrams only: chance each one arrives twice. */
  duplicateRate: number;
}

export type TraceEvent = {
  readonly time: number;
  readonly kind: "connect" | "refuse" | "open" | "send" | "deliver" | "lose" | "close" | "break";
  readonly from: string;
  readonly to: string;
  readonly size?: number;
};

const DEFAULTS: LinkOptions = { latency: [5, 50], dropRate: 0, duplicateRate: 0 };

/** How long a failed connection attempt takes to give up, in virtual milliseconds. */
const CONNECT_TIMEOUT = 1000;
/** How long an end takes to notice its peer is gone (a missed ping), in virtual milliseconds. */
const DEAD_PEER_TIMEOUT: readonly [number, number] = [200, 2000];

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const size = (data: Payload) => (typeof data === "string" ? data.length : data.byteLength);
const copy = (data: Payload): Payload => (typeof data === "string" ? data : data.slice());

/**
 * A simulated network between named nodes.
 *
 * - Connections behave like TCP: in order, no loss, no duplicates, with a
 *   random one-way latency. A partition or crash breaks them: messages in
 *   flight are lost and each surviving end notices after a random delay,
 *   the way a WebSocket notices a dead peer through a missed ping.
 * - Datagrams behave like UDP: each one can be delayed (and so reordered),
 *   dropped or duplicated.
 *
 * Everything runs in the simulation's virtual time with its seeded random
 * generator, so a seed replays the exact same sequence of events.
 */
export class Network {
  private readonly options: LinkOptions;
  private readonly listeners = new Map<string, (connection: Connection) => void>();
  private readonly datagramHandlers = new Map<string, (data: Payload, from: string) => void>();
  private readonly blocked = new Set<string>();
  private readonly isolated = new Set<string>();
  private readonly links = new Set<Link>();
  onTrace: ((event: TraceEvent) => void) | null = null;

  constructor(
    readonly sim: Simulation,
    options: Partial<LinkOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Accepts connections to `node`. A node that crashed must listen again after it restarts. */
  listen(node: string, onConnection: (connection: Connection) => void): void {
    this.listeners.set(node, onConnection);
  }

  /** Opens a connection from `from` to `to`. It fires `onopen`, or `onclose` if `to` can't be reached. */
  connect(from: string, to: string): Connection {
    const link = new Link(this, from, to);
    this.links.add(link);
    this.trace("connect", from, to);
    this.sim.schedule(this.latency(), () => {
      const accept = this.listeners.get(to);
      if (
        !accept ||
        link.broken ||
        !this.canReach(from, to) ||
        link.client.readyState !== "connecting"
      ) {
        this.trace("refuse", from, to);
        // The caller learns of a refusal right away, of silence only after a timeout.
        const delay = accept && this.canReach(from, to) ? this.latency() : CONNECT_TIMEOUT;
        this.sim.schedule(delay, () => link.finish());
        return;
      }
      link.server.readyState = "open";
      accept(link.server);
      this.sim.schedule(this.latency(), () => {
        if (link.broken) return;
        link.client.readyState = "open";
        this.trace("open", from, to);
        link.client.onopen?.();
      });
    });
    return link.client;
  }

  /** Sends one unreliable datagram. */
  sendDatagram(from: string, to: string, data: Payload): void {
    this.trace("send", from, to, size(data));
    const copies = this.sim.random.chance(this.options.duplicateRate) ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      if (!this.canReach(from, to) || this.sim.random.chance(this.options.dropRate)) {
        this.trace("lose", from, to, size(data));
        continue;
      }
      const payload = copy(data);
      this.sim.schedule(this.latency(), () => {
        const handler = this.datagramHandlers.get(to);
        if (!handler || !this.canReach(from, to)) return this.trace("lose", from, to, size(data));
        this.trace("deliver", from, to, size(data));
        handler(payload, from);
      });
    }
  }

  onDatagram(node: string, handler: (data: Payload, from: string) => void): void {
    this.datagramHandlers.set(node, handler);
  }

  /** Cuts every link between a node in `a` and a node in `b`. */
  partition(a: readonly string[], b: readonly string[]): void {
    for (const x of a) for (const y of b) this.blocked.add(pairKey(x, y));
    this.breakUnreachable();
  }

  /** Cuts `node` off from every other node. */
  isolate(node: string): void {
    this.isolated.add(node);
    this.breakUnreachable();
  }

  /** Removes every partition. Broken connections stay broken; clients must reconnect. */
  heal(): void {
    this.blocked.clear();
    this.isolated.clear();
  }

  canReach(a: string, b: string): boolean {
    return !this.isolated.has(a) && !this.isolated.has(b) && !this.blocked.has(pairKey(a, b));
  }

  /**
   * Kills `node`: its connections break, its listener and datagram handler
   * go away, and it gets no callbacks. Peers notice after a delay.
   */
  crash(node: string): void {
    this.listeners.delete(node);
    this.datagramHandlers.delete(node);
    for (const link of this.links) {
      if (link.client.local === node || link.server.local === node) link.break(node);
    }
  }

  /** A random one-way delay. */
  latency(): number {
    const [min, max] = this.options.latency;
    return this.sim.random.int(min, max);
  }

  /** @internal */
  trace(kind: TraceEvent["kind"], from: string, to: string, bytes?: number): void {
    if (!this.onTrace) return;
    this.onTrace(
      bytes === undefined
        ? { time: this.sim.now, kind, from, to }
        : { time: this.sim.now, kind, from, to, size: bytes },
    );
  }

  /** @internal */
  forget(link: Link): void {
    this.links.delete(link);
  }

  private breakUnreachable(): void {
    for (const link of this.links) {
      if (!this.canReach(link.client.local, link.server.local)) link.break(null);
    }
  }
}

class End implements Connection {
  readyState: ReadyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((data: Payload) => void) | null = null;
  onclose: (() => void) | null = null;
  /** Virtual time the last message sent from this end arrives, to keep delivery in order. */
  lastArrival = 0;
  /** `onclose` fires at most once per end. */
  notifiedClose = false;

  constructor(
    private readonly link: Link,
    readonly local: string,
    readonly remote: string,
  ) {}

  send(data: Payload): void {
    if (this.readyState !== "open") return;
    this.link.transmit(this, copy(data));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.link.closeFrom(this);
  }
}

class Link {
  readonly client: End;
  readonly server: End;
  broken = false;
  private closing = false;

  constructor(
    private readonly network: Network,
    from: string,
    to: string,
  ) {
    this.client = new End(this, from, to);
    this.server = new End(this, to, from);
  }

  private other(end: End): End {
    return end === this.client ? this.server : this.client;
  }

  transmit(from: End, data: Payload): void {
    const net = this.network;
    const to = this.other(from);
    const arrival = Math.max(from.lastArrival, net.sim.now + net.latency());
    from.lastArrival = arrival;
    net.trace("send", from.local, to.local, size(data));
    net.sim.schedule(arrival - net.sim.now, () => {
      if (this.broken || to.readyState === "closed") {
        net.trace("lose", from.local, to.local, size(data));
        return;
      }
      net.trace("deliver", from.local, to.local, size(data));
      to.onmessage?.(data);
    });
  }

  /** Graceful close: the other end gets everything already sent, then `onclose`. */
  closeFrom(end: End): void {
    if (this.closing || this.broken) return;
    this.closing = true;
    const net = this.network;
    const other = this.other(end);
    end.readyState = "closed";
    net.trace("close", end.local, other.local);
    const arrival = Math.max(end.lastArrival, net.sim.now + net.latency());
    net.sim.schedule(arrival - net.sim.now, () => {
      if (this.broken) return;
      this.notifyClose(other);
      // The closing side's own close event fires once the other side acknowledges.
      net.sim.schedule(net.latency(), () => this.finish());
    });
  }

  /** The link died (partition or crash). `dead` names a crashed node, which gets no callbacks. */
  break(dead: string | null): void {
    if (this.broken) return;
    this.broken = true;
    const net = this.network;
    net.trace("break", this.client.local, this.server.local);
    for (const end of [this.client, this.server]) {
      if (end.local === dead) {
        end.readyState = "closed";
        end.notifiedClose = true;
        continue;
      }
      // Sends are lost from now on; this end notices after a ping timeout.
      const [min, max] = DEAD_PEER_TIMEOUT;
      net.sim.schedule(net.sim.random.int(min, max), () => this.notifyClose(end));
    }
    net.forget(this);
  }

  /** Closes both ends, as after a refused or completed connection. */
  finish(): void {
    this.notifyClose(this.client);
    this.notifyClose(this.server);
    this.network.forget(this);
  }

  private notifyClose(end: End): void {
    end.readyState = "closed";
    if (end.notifiedClose) return;
    end.notifiedClose = true;
    end.onclose?.();
  }
}
