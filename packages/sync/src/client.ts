import * as decoding from "lib0/decoding";
import { type Awareness, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as sync from "y-protocols/sync";
import type * as Y from "yjs";
import {
  awarenessMessage,
  HEARTBEAT,
  MessageType,
  readSync,
  syncStep1,
  syncUpdate,
} from "./protocol";
import type { Socket } from "./socket";

/**
 * - `connecting`: opening a connection, or opened but not caught up yet.
 * - `online`: caught up; edits flow both ways as they happen.
 * - `offline`: the connection dropped; waiting to retry. Edits keep working
 *   locally and are sent on reconnect.
 * - `denied`: the link doesn't grant access. No more retries.
 */
export type SyncStatus = "connecting" | "online" | "offline" | "denied";

/** Thrown by `connect` when access is refused for good (a bad link, not an expired token). */
export class AccessDenied extends Error {}

export interface SyncClientOptions {
  doc: Y.Doc;
  awareness: Awareness;
  /** Opens a connection to the room. May fetch a token first. */
  connect: () => Socket | Promise<Socket>;
  /** Timer, injectable so tests run in virtual time. Returns a cancel function. */
  schedule?: (delayMs: number, fn: () => void) => () => void;
  /** A number in [0, 1), for reconnect jitter. */
  random?: () => number;
  /**
   * Sends a heartbeat this often, and gives up on a connection that has been
   * silent for two of these. Browsers hide WebSocket pings from scripts, so
   * this is how the client notices a dead connection. 0 turns it off.
   */
  heartbeatMs?: number;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** Above this many queued bytes, cursor updates are skipped; the next one replaces them. */
const CONGESTED_BYTES = 64 * 1024;

const defaultSchedule = (delayMs: number, fn: () => void) => {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Keeps a Y.Doc and its awareness in sync with a room on the server.
 *
 * There is no queue of unsent edits: the document itself is the queue. On
 * every (re)connect both sides swap state vectors and send each other what
 * the other is missing, so edits made offline go out then.
 */
export class SyncClient {
  private socket: Socket | null = null;
  private open = false;
  private currentStatus: SyncStatus = "connecting";
  private attempt = 0;
  private cancelRetry: (() => void) | null = null;
  private cancelHeartbeat: (() => void) | null = null;
  private heardSinceBeat = true;
  private silentBeats = 0;
  private destroyed = false;
  private readOnlyReason: string | null = null;
  /** The current connection said the room is read-only. */
  private toldReadOnly = false;
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private readonly schedule: (delayMs: number, fn: () => void) => () => void;
  private readonly random: () => number;
  private readonly heartbeatMs: number;

  constructor(private readonly options: SyncClientOptions) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.random = options.random ?? Math.random;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    options.doc.on("update", this.sendUpdate);
    options.awareness.on("update", this.sendAwareness);
    this.connect();
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  /**
   * Why the room takes no more changes (it's full, say), or null while it
   * does. Edits made meanwhile stay in this copy only.
   */
  get readOnly(): string | null {
    return this.readOnlyReason;
  }

  /** Calls `listener` on every change of `status` or `readOnly`. Returns an unsubscribe function. */
  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Skips the backoff wait, for when the browser says it's back online. */
  reconnectNow(): void {
    if (!this.cancelRetry) return;
    this.cancelRetry();
    this.cancelRetry = null;
    this.attempt = 0;
    this.connect();
  }

  /** Says goodbye (removes this user's presence) and stops for good. */
  destroy(): void {
    if (this.destroyed) return;
    // Sent while the handlers are still attached.
    this.options.awareness.setLocalState(null);
    this.destroyed = true;
    this.cancelRetry?.();
    this.cancelHeartbeat?.();
    this.options.doc.off("update", this.sendUpdate);
    this.options.awareness.off("update", this.sendAwareness);
    const socket = this.socket;
    this.detach();
    socket?.close(1000, "bye");
    this.listeners.clear();
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.notify();
  }

  private setReadOnly(reason: string | null): void {
    if (reason === this.readOnlyReason) return;
    this.readOnlyReason = reason;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.currentStatus);
  }

  private connect(): void {
    if (this.destroyed) return;
    this.setStatus("connecting");
    let result: Socket | Promise<Socket>;
    try {
      result = this.options.connect();
    } catch (error) {
      this.connectFailed(error);
      return;
    }
    // Attach synchronously when we can, so a simulated network stays deterministic.
    if (result instanceof Promise)
      result.then(
        (s) => this.attach(s),
        (e: unknown) => this.connectFailed(e),
      );
    else this.attach(result);
  }

  private connectFailed(error: unknown): void {
    if (this.destroyed) return;
    if (error instanceof AccessDenied) this.setStatus("denied");
    else this.retry();
  }

  private attach(socket: Socket): void {
    if (this.destroyed) {
      socket.close(1000, "bye");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.toldReadOnly = false;
      socket.send(syncStep1(this.options.doc));
      // Re-announce our presence with a new clock. Peers that saw us leave
      // kept our old clock, and ignore a state that isn't newer than it.
      const { awareness } = this.options;
      const presence = awareness.getLocalState();
      if (presence !== null) awareness.setLocalState(presence);
      this.startHeartbeat(socket);
    };
    socket.onmessage = (data) => {
      if (this.socket !== socket) return;
      this.heardSinceBeat = true;
      this.receive(socket, data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.detach();
      // Each retry calls `connect` again, which fetches a fresh token.
      this.retry();
    };
  }

  /** Forgets the current connection and everyone else's presence. */
  private detach(): void {
    const { awareness } = this.options;
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onclose = null;
    }
    this.socket = null;
    this.open = false;
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    const others = [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
    if (others.length > 0) removeAwarenessStates(awareness, others, this);
    // Forget their clocks too: on reconnect the room re-sends their current
    // states, and those must be accepted even if their clocks haven't moved.
    for (const id of others) awareness.meta.delete(id);
  }

  private retry(): void {
    if (this.destroyed) return;
    this.setStatus("offline");
    // Exponential backoff with equal jitter (lab L3): half fixed, half random.
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = ceiling / 2 + this.random() * (ceiling / 2);
    this.attempt++;
    this.cancelRetry = this.schedule(delay, () => {
      this.cancelRetry = null;
      this.connect();
    });
  }

  private startHeartbeat(socket: Socket): void {
    if (this.heartbeatMs <= 0) return;
    this.heardSinceBeat = true;
    this.silentBeats = 0;
    const beat = () => {
      if (this.socket !== socket) return;
      this.silentBeats = this.heardSinceBeat ? 0 : this.silentBeats + 1;
      this.heardSinceBeat = false;
      if (this.silentBeats >= 2) {
        // Closing a dead TCP connection can take minutes; don't wait for it.
        this.detach();
        socket.close(4000, "no heartbeat");
        this.retry();
        return;
      }
      socket.send(HEARTBEAT);
      this.cancelHeartbeat = this.schedule(this.heartbeatMs, beat);
    };
    this.cancelHeartbeat = this.schedule(this.heartbeatMs, beat);
  }

  private receive(socket: Socket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MessageType.Sync) {
      const { type: syncType, reply } = readSync(decoder, this.options.doc, this);
      if (reply) socket.send(reply);
      // The room's answer to our step 1: we have everything it had.
      if (syncType === sync.messageYjsSyncStep2) {
        this.attempt = 0;
        // A read-only room says so before step 1, so silence means it isn't.
        if (!this.toldReadOnly) this.setReadOnly(null);
        this.setStatus("online");
      }
    } else if (type === MessageType.Awareness) {
      applyAwarenessUpdate(this.options.awareness, decoding.readVarUint8Array(decoder), this);
    } else if (type === MessageType.ReadOnly) {
      this.toldReadOnly = true;
      this.setReadOnly(decoding.readVarString(decoder));
    }
  }

  private readonly sendUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.open) return;
    this.socket?.send(syncUpdate(update));
  };

  private readonly sendAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const { awareness } = this.options;
    if (origin === this || !this.open || !this.socket) return;
    const mine = [...changes.added, ...changes.updated, ...changes.removed].includes(
      awareness.clientID,
    );
    if (!mine) return;
    // Cursors are disposable: when the connection is backed up, skip this one.
    // A removal (leaving) is always sent.
    const leaving = awareness.getLocalState() === null;
    if (!leaving && (this.socket.bufferedAmount ?? 0) > CONGESTED_BYTES) return;
    this.socket.send(awarenessMessage(awareness, [awareness.clientID]));
  };
}
