import type { Connection } from "@niro/netsim";
import {
  type ClientMessage,
  decode,
  encode,
  type SequencedOp,
  type ServerMessage,
  type Value,
} from "./protocol";

export interface SyncServerOptions {
  /** Ops kept for catching up reconnecting clients; clients further behind get a snapshot. */
  logLimit?: number;
  /**
   * Remember the highest clientSeq applied for each client, so the server can
   * tell a reconnecting client which of its edits already landed and drop
   * retries of them. Only turned off to show what goes wrong without it.
   */
  idempotency?: boolean;
  /** Called for every op the server applies, in order. */
  onApply?: (op: SequencedOp) => void;
}

/**
 * The authority. Every edit goes through here, gets the next sequence
 * number, and is broadcast to everyone, so all clients see one history in
 * one order. Concurrent edits to the same key resolve as "last to reach the
 * server wins": that is the whole conflict rule.
 *
 * State, log and the idempotency record are treated as durable: a crashed
 * server comes back with them, as if each op were written to disk before
 * it was broadcast. Only the connections are lost.
 */
export class SyncServer {
  readonly state = new Map<string, Value>();
  /** Highest clientSeq applied per client: the idempotency record. */
  readonly applied = new Map<string, number>();
  readonly stats = { welcomes: 0, snapshots: 0, retriesDropped: 0 };
  /** Ops that arrived with a clientSeq gap. A correct client never causes this. */
  gaps = 0;
  private readonly log: SequencedOp[] = [];
  private head = 0;
  private readonly clients = new Set<Connection>();
  private readonly logLimit: number;
  private readonly idempotency: boolean;
  private readonly onApply: ((op: SequencedOp) => void) | undefined;

  constructor(options: SyncServerOptions = {}) {
    this.logLimit = Math.max(1, options.logLimit ?? 1000);
    this.idempotency = options.idempotency ?? true;
    this.onApply = options.onApply;
  }

  /** Sequence number of the latest op. */
  get lastSeq(): number {
    return this.head;
  }

  /** The ops still in the catch-up log, oldest first. */
  history(): readonly SequencedOp[] {
    return this.log;
  }

  accept(connection: Connection): void {
    connection.onmessage = (data) => this.receive(connection, decode<ClientMessage>(data));
    connection.onclose = () => this.clients.delete(connection);
  }

  /** After a crash: every connection is gone; durable state survives. */
  restart(): void {
    this.clients.clear();
  }

  private receive(connection: Connection, message: ClientMessage): void {
    if (message.t === "hello") {
      this.clients.add(connection);
      this.stats.welcomes++;
      const acked = this.idempotency ? (this.applied.get(message.clientId) ?? 0) : 0;
      // The log covers the client if it holds every op after the client's lastSeq.
      const oldest = this.log[0]?.seq ?? this.head + 1;
      let welcome: ServerMessage;
      if (message.lastSeq >= oldest - 1) {
        welcome = { t: "welcome", acked, ops: this.log.filter((op) => op.seq > message.lastSeq) };
      } else {
        this.stats.snapshots++;
        welcome = { t: "welcome", acked, snapshot: { seq: this.head, entries: [...this.state] } };
      }
      connection.send(encode(welcome));
      return;
    }

    // An op before hello breaks the protocol; drop it.
    if (!this.clients.has(connection)) return;
    const { op } = message;
    const last = this.applied.get(op.clientId) ?? 0;
    if (this.idempotency && op.clientSeq <= last) {
      this.stats.retriesDropped++;
      return;
    }
    if (op.clientSeq > last + 1) this.gaps++;

    const sequenced: SequencedOp = { ...op, seq: ++this.head };
    if (op.value === null) this.state.delete(op.key);
    else this.state.set(op.key, op.value);
    this.applied.set(op.clientId, Math.max(last, op.clientSeq));
    this.log.push(sequenced);
    if (this.log.length > this.logLimit) this.log.shift();
    this.onApply?.(sequenced);

    const broadcast = encode({ t: "op", op: sequenced });
    for (const client of this.clients) client.send(broadcast);
  }
}
