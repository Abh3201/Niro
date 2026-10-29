import * as Y from "yjs";
import { ReadOnlyReason } from "./protocol";
import { Room } from "./room";

/**
 * Where boards are kept between sessions. The realtime server uses
 * Postgres; tests and development use `MemoryStorage`.
 *
 * Everything is stored as Yjs updates. Applying the same update twice is
 * harmless and order doesn't matter, so a board is simply "all of these".
 */
export interface BoardStorage {
  /** Everything stored for the board, to apply in any order. Empty for a new board. */
  load(boardId: string): Promise<Uint8Array[]>;
  /** Adds one update. */
  append(boardId: string, update: Uint8Array): Promise<void>;
  /** Replaces everything stored for the board with `state`, which must contain all of it. */
  replace(boardId: string, state: Uint8Array): Promise<void>;
}

/** A board checked out of the host. Release it when the connection that needed it closes. */
export interface Lease {
  readonly room: Room;
  /** Gives the room back. Safe to call more than once. */
  release(): void;
}

export interface FlushInfo {
  readonly boardId: string;
  /** Bytes written. */
  readonly bytes: number;
  /** True when the board's stored updates were replaced by one snapshot. */
  readonly compacted: boolean;
  readonly durationMs: number;
  /** Roughly how big the whole board is now, in bytes. Never less than it is. */
  readonly documentBytes: number;
}

export interface RoomHostOptions {
  storage: BoardStorage;
  /** Timer, injectable so tests run in virtual time. Returns a cancel function. */
  schedule?: (delayMs: number, fn: () => void) => () => void;
  now?: () => number;
  /** A write waits this long for more changes to batch with. Default 2 s. */
  flushDelayMs?: number;
  /** ...but no longer than this after the first unwritten change. Default 10 s. */
  maxFlushDelayMs?: number;
  /** After a failed write, try again this much later. Default 5 s. */
  retryDelayMs?: number;
  /** Replace a board's stored updates with one snapshot after this many writes. Default 100. */
  compactAfter?: number;
  /** A room goes read-only once its document is about this big. Default 20 MB. */
  maxDocumentBytes?: number;
  /** Other limits, checked after every change (the number of shapes, say). */
  isFull?: (doc: Y.Doc) => boolean;
  onFlush?: (info: FlushInfo) => void;
  onError?: (error: unknown, boardId: string) => void;
}

/** Transaction origin for loading from storage: not a change to write back. */
const LOADED = Symbol("niro.loaded");

interface Entry {
  readonly boardId: string;
  /** Leases out. At 0 the room is written and closed. */
  refs: number;
  ready: Promise<Room>;
  room: Room | null;
  /** Changes not written yet. */
  pending: Uint8Array[];
  firstPendingAt: number | null;
  cancelFlush: (() => void) | null;
  /** Storage writes run one at a time, in this chain. */
  writes: Promise<void>;
  /** Writes since the last snapshot. */
  appends: number;
  /**
   * Roughly how big the document is: its size when last measured plus every
   * change since. Never less than it is; it shrinks when measured again.
   */
  bytes: number;
  /** `bytes` above which the document is measured again. */
  measureAbove: number;
  closing: boolean;
  /** Erased: nothing more is written, whatever arrives. */
  discarded: boolean;
}

const defaultSchedule = (delayMs: number, fn: () => void) => {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Keeps one `Room` per open board, loaded from storage when the first
 * person connects, and written back as people edit.
 *
 * Writes are debounced: 2 s after the last change, and at most 10 s after
 * the first unwritten one, so a drag is one row rather than sixty a second.
 * If the server dies, it loses at most that window, and any browser that
 * still has the board sends it again in the sync handshake when it
 * reconnects. When the last person leaves, the board is written and the
 * room closed.
 */
export class RoomHost {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  /** Totals from rooms already closed; open rooms keep their own. */
  private readonly closedStats = { updatesApplied: 0, updatesRefused: 0 };
  private readonly schedule: (delayMs: number, fn: () => void) => () => void;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly maxFlushDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly compactAfter: number;
  private readonly maxDocumentBytes: number;

  constructor(private readonly options: RoomHostOptions) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.flushDelayMs = options.flushDelayMs ?? 2_000;
    this.maxFlushDelayMs = options.maxFlushDelayMs ?? 10_000;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.compactAfter = options.compactAfter ?? 100;
    this.maxDocumentBytes = options.maxDocumentBytes ?? 20 * 1024 * 1024;
  }

  /** Open rooms, by board id. */
  get rooms(): ReadonlyMap<string, Room> {
    const rooms = new Map<string, Room>();
    for (const [id, entry] of this.entries) if (entry.room) rooms.set(id, entry.room);
    return rooms;
  }

  /** Document updates applied and refused, across every room since the host started. */
  get stats(): { updatesApplied: number; updatesRefused: number } {
    const totals = { ...this.closedStats };
    for (const entry of this.entries.values()) {
      totals.updatesApplied += entry.room?.stats.updatesApplied ?? 0;
      totals.updatesRefused += entry.room?.stats.updatesRefused ?? 0;
    }
    return totals;
  }

  /** True while the board is open or loading. */
  isOpen(boardId: string): boolean {
    return this.entries.has(boardId);
  }

  /**
   * Roughly how big the open boards are together, as stored: never less
   * than they are. A board still loading counts as nothing yet.
   */
  get openBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) if (entry.room) bytes += entry.bytes;
    return bytes;
  }

  /** Changes waiting to be written, across all rooms. */
  get unwritten(): number {
    let count = 0;
    for (const entry of this.entries.values()) count += entry.pending.length;
    return count;
  }

  /**
   * The board's room, loaded first if nobody has it open. Rejects if
   * storage fails; nothing is held then, so there's nothing to release.
   */
  async acquire(boardId: string): Promise<Lease> {
    if (this.closed) throw new Error("The room host is closed.");
    let entry = this.entries.get(boardId);
    if (entry) {
      // Someone arriving while the room closes keeps it open.
      entry.closing = false;
    } else {
      entry = this.open(boardId);
    }
    entry.refs++;
    const room = await entry.ready;
    const held = entry;
    let released = false;
    return {
      room,
      release: () => {
        if (released) return;
        released = true;
        this.release(held);
      },
    };
  }

  /** Writes everything unwritten now, in every room. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.flush(entry)));
  }

  /** Writes every room and closes them all. Further `acquire` calls fail. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await entry.ready.catch(() => {});
        await this.flush(entry);
        this.drop(entry);
      }),
    );
  }

  /**
   * Closes the board's room without writing what's unwritten, for a board
   * being erased. Resolves once any write already under way has finished,
   * so erasing the storage afterwards leaves nothing behind. Whoever still
   * holds a lease keeps a dead room; close their connections first.
   */
  async discard(boardId: string): Promise<void> {
    const entry = this.entries.get(boardId);
    if (!entry) return;
    entry.discarded = true;
    entry.pending = [];
    this.drop(entry);
    await entry.writes;
  }

  private open(boardId: string): Entry {
    // `ready` is set just below; `load` doesn't read it.
    const entry = {
      boardId,
      refs: 0,
      room: null,
      pending: [],
      firstPendingAt: null,
      cancelFlush: null,
      writes: Promise.resolve(),
      appends: 0,
      bytes: 0,
      measureAbove: this.maxDocumentBytes,
      closing: false,
      discarded: false,
    } as Omit<Entry, "ready"> as Entry;
    entry.ready = this.load(entry);
    this.entries.set(boardId, entry);
    return entry;
  }

  private async load(entry: Entry): Promise<Room> {
    let updates: Uint8Array[];
    try {
      updates = await this.options.storage.load(entry.boardId);
    } catch (error) {
      // Nobody gets a room that's missing its stored content.
      if (this.entries.get(entry.boardId) === entry) this.entries.delete(entry.boardId);
      throw error;
    }
    const room = new Room();
    if (updates.length > 0) Y.applyUpdate(room.doc, Y.mergeUpdates(updates), LOADED);
    entry.room = room;
    entry.appends = updates.length;
    entry.bytes = updates.reduce((sum, update) => sum + update.length, 0);
    room.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== LOADED) this.changed(entry, update);
    });
    this.checkLimits(entry);
    return room;
  }

  private changed(entry: Entry, update: Uint8Array): void {
    if (entry.discarded) return;
    entry.pending.push(update);
    entry.bytes += update.length;
    this.checkLimits(entry);
    // Shutting down: `close` is writing everything, and nothing comes after it.
    if (this.closed) return;
    const now = this.now();
    entry.firstPendingAt ??= now;
    const due = Math.min(this.flushDelayMs, entry.firstPendingAt + this.maxFlushDelayMs - now);
    this.scheduleFlush(entry, Math.max(0, due));
  }

  private checkLimits(entry: Entry): void {
    const room = entry.room;
    if (!room || room.readOnly !== null) return;
    if (entry.bytes > entry.measureAbove) {
      // The estimate counts every change in full, though an edit that
      // replaces a value frees most of the old one. Measure before refusing:
      // a busy board would otherwise fill up on paper long before it does.
      this.measured(entry, Y.encodeStateAsUpdate(room.doc).length);
      if (entry.bytes > this.maxDocumentBytes) {
        room.setReadOnly(ReadOnlyReason.Full);
        return;
      }
    }
    let full = false;
    try {
      full = this.options.isFull?.(room.doc) ?? false;
    } catch (error) {
      this.options.onError?.(error, entry.boardId);
    }
    if (full) room.setReadOnly(ReadOnlyReason.Full);
  }

  /**
   * Records the document's exact size. Measuring a big board isn't free, so
   * it isn't measured again until another 5% of the limit has changed: a
   * board can end up that much over the limit before it goes read-only.
   */
  private measured(entry: Entry, bytes: number): void {
    entry.bytes = bytes;
    entry.measureAbove = Math.max(this.maxDocumentBytes, bytes + this.maxDocumentBytes / 20);
  }

  private scheduleFlush(entry: Entry, delayMs: number): void {
    entry.cancelFlush?.();
    entry.cancelFlush = this.schedule(delayMs, () => {
      entry.cancelFlush = null;
      void this.flush(entry);
    });
  }

  /** Writes what's unwritten, after any write already under way. */
  private flush(entry: Entry): Promise<void> {
    entry.writes = entry.writes.then(() => this.write(entry));
    return entry.writes;
  }

  /** One write. Never rejects: a failed write is kept and tried again later. */
  private async write(entry: Entry): Promise<void> {
    const room = entry.room;
    const updates = entry.pending;
    if (!room || updates.length === 0) return;
    entry.pending = [];
    entry.firstPendingAt = null;
    entry.cancelFlush?.();
    entry.cancelFlush = null;

    // A snapshot is taken from the room, so it also holds everything
    // applied since `pending` was taken: there is nothing in between.
    const compact = entry.appends + 1 >= this.compactAfter;
    const data = compact ? Y.encodeStateAsUpdate(room.doc) : Y.mergeUpdates(updates);
    const started = this.now();
    try {
      if (compact) await this.options.storage.replace(entry.boardId, data);
      else await this.options.storage.append(entry.boardId, data);
    } catch (error) {
      entry.pending.unshift(...updates);
      entry.firstPendingAt ??= this.now();
      this.options.onError?.(error, entry.boardId);
      if (!this.closed) this.scheduleFlush(entry, this.retryDelayMs);
      return;
    }
    if (compact) {
      entry.appends = 0;
      // Exact again, plus whatever changed during the write.
      this.measured(
        entry,
        data.length + entry.pending.reduce((sum, update) => sum + update.length, 0),
      );
    } else {
      entry.appends++;
    }
    this.options.onFlush?.({
      boardId: entry.boardId,
      bytes: data.length,
      compacted: compact,
      durationMs: this.now() - started,
      documentBytes: entry.bytes,
    });
  }

  private release(entry: Entry): void {
    entry.refs--;
    if (entry.refs > 0 || this.closed) return;
    entry.closing = true;
    void this.closeWhenWritten(entry);
  }

  private async closeWhenWritten(entry: Entry): Promise<void> {
    // Keep trying: while a change is unwritten, this room is the only copy
    // the server has. (The browsers that made it have it too.)
    for (;;) {
      await this.flush(entry);
      if (!entry.closing) return; // someone came back
      if (entry.pending.length === 0) break;
      await new Promise<void>((resolve) => this.schedule(this.retryDelayMs, resolve));
      if (!entry.closing) return;
    }
    this.drop(entry);
  }

  private drop(entry: Entry): void {
    entry.cancelFlush?.();
    entry.cancelFlush = null;
    if (entry.room) {
      this.closedStats.updatesApplied += entry.room.stats.updatesApplied;
      this.closedStats.updatesRefused += entry.room.stats.updatesRefused;
    }
    entry.room?.destroy();
    entry.room = null;
    if (this.entries.get(entry.boardId) === entry) this.entries.delete(entry.boardId);
  }
}

/** Boards kept in memory: for tests, and for development without Postgres. Lost on restart. */
export class MemoryStorage implements BoardStorage {
  private readonly boards = new Map<string, Uint8Array[]>();

  async load(boardId: string): Promise<Uint8Array[]> {
    return [...(this.boards.get(boardId) ?? [])];
  }

  async append(boardId: string, update: Uint8Array): Promise<void> {
    const updates = this.boards.get(boardId) ?? [];
    updates.push(update);
    this.boards.set(boardId, updates);
  }

  async replace(boardId: string, state: Uint8Array): Promise<void> {
    this.boards.set(boardId, [state]);
  }

  /** Forgets a board. */
  erase(boardId: string): void {
    this.boards.delete(boardId);
  }

  /** Rows stored for a board, for tests. */
  rows(boardId: string): number {
    return this.boards.get(boardId)?.length ?? 0;
  }
}
