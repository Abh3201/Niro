import type { Connection } from "@niro/netsim";
import {
  decode,
  encode,
  type Op,
  type SequencedOp,
  type ServerMessage,
  type Value,
} from "./protocol";

/** Everything a client keeps across a crash, as it would in IndexedDB. */
export interface ClientState {
  readonly confirmed: ReadonlyArray<[string, Value]>;
  readonly lastSeq: number;
  readonly pending: readonly Op[];
  readonly nextClientSeq: number;
}

export interface SyncClientOptions {
  clientId: string;
  /** Opens a new connection to the server. */
  connect: () => Connection;
  /** Timer, injected so the client runs in virtual time. Returns a cancel function. */
  schedule: (delayMs: number, fn: () => void) => () => void;
  /** A number in [0, 1), for reconnect jitter. */
  random: () => number;
  /** State saved before a crash. */
  restore?: ClientState;
}

const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 10_000;

/**
 * An optimistic client. Local edits apply at once (`pending`) and are sent
 * to the server; the server's ordered stream of ops builds `confirmed`.
 * What the user sees is `confirmed` with `pending` replayed on top, so a
 * local edit never flickers back while it waits for the server.
 *
 * After a disconnect it reconnects with exponential backoff and jitter,
 * says which op it saw last, and resends whatever the server hadn't applied.
 */
export class SyncClient {
  readonly clientId: string;
  private confirmed: Map<string, Value>;
  private lastSeq: number;
  private pending: Op[];
  private nextClientSeq: number;
  private connection: Connection | null = null;
  private synced = false;
  private attempt = 0;
  private cancelRetry: (() => void) | null = null;
  private dead = false;
  /** Protocol violations seen from the server. A correct server never causes these. */
  readonly errors: string[] = [];

  constructor(private readonly options: SyncClientOptions) {
    this.clientId = options.clientId;
    const saved = options.restore;
    this.confirmed = new Map(saved?.confirmed ?? []);
    this.lastSeq = saved?.lastSeq ?? 0;
    this.pending = [...(saved?.pending ?? [])];
    this.nextClientSeq = saved?.nextClientSeq ?? 1;
    this.open();
  }

  /** Makes an edit. It shows in `view()` immediately. */
  set(key: string, value: Value): void {
    if (this.dead) return;
    const op: Op = { clientId: this.clientId, clientSeq: this.nextClientSeq++, key, value };
    this.pending.push(op);
    if (this.synced) this.connection?.send(encode({ t: "op", op }));
  }

  /** What the user sees: server-confirmed state with unconfirmed local edits on top. */
  view(): Map<string, Value> {
    const view = new Map(this.confirmed);
    for (const op of this.pending) {
      if (op.value === null) view.delete(op.key);
      else view.set(op.key, op.value);
    }
    return view;
  }

  /** Edits not yet confirmed by the server. */
  get unconfirmed(): number {
    return this.pending.length;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /** Total edits this client has made, across restarts. */
  get opsMade(): number {
    return this.nextClientSeq - 1;
  }

  save(): ClientState {
    return {
      confirmed: [...this.confirmed],
      lastSeq: this.lastSeq,
      pending: [...this.pending],
      nextClientSeq: this.nextClientSeq,
    };
  }

  /** Simulates the process dying: no more timers, sends or callbacks. */
  kill(): void {
    this.dead = true;
    this.cancelRetry?.();
    this.connection = null;
  }

  private open(): void {
    if (this.dead) return;
    const connection = this.options.connect();
    this.connection = connection;
    connection.onopen = () => {
      if (this.dead || this.connection !== connection) return;
      connection.send(encode({ t: "hello", clientId: this.clientId, lastSeq: this.lastSeq }));
    };
    connection.onmessage = (data) => {
      if (this.dead || this.connection !== connection) return;
      this.receive(decode<ServerMessage>(data));
    };
    connection.onclose = () => {
      if (this.dead || this.connection !== connection) return;
      this.connection = null;
      this.synced = false;
      this.retry();
    };
  }

  private retry(): void {
    // Exponential backoff with "equal jitter": half fixed, half random, so a
    // server restart isn't hit by every client at the same instant.
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = ceiling / 2 + this.options.random() * (ceiling / 2);
    this.attempt++;
    this.cancelRetry = this.options.schedule(delay, () => {
      this.cancelRetry = null;
      this.open();
    });
  }

  private receive(message: ServerMessage): void {
    if (message.t === "welcome") {
      if (message.snapshot) {
        this.confirmed = new Map(message.snapshot.entries);
        this.lastSeq = message.snapshot.seq;
      }
      for (const op of message.ops ?? []) this.apply(op);
      // Anything the server already applied is confirmed, even if we never saw the echo.
      this.pending = this.pending.filter((op) => op.clientSeq > message.acked);
      this.synced = true;
      this.attempt = 0;
      for (const op of this.pending) this.connection?.send(encode({ t: "op", op }));
      return;
    }
    this.apply(message.op);
  }

  private apply(op: SequencedOp): void {
    if (op.seq <= this.lastSeq) return; // already have it
    if (op.seq !== this.lastSeq + 1)
      this.errors.push(`gap: expected ${this.lastSeq + 1}, got ${op.seq}`);
    if (op.value === null) this.confirmed.delete(op.key);
    else this.confirmed.set(op.key, op.value);
    this.lastSeq = op.seq;
    if (op.clientId === this.clientId) {
      this.pending = this.pending.filter((p) => p.clientSeq > op.clientSeq);
    }
  }
}
