/**
 * `DocStore` on Yjs. Only apps import this module; the engine sees the
 * interface alone.
 *
 * Layout of the Y.Doc:
 * - `shapes`: Y.Map from shape id to a Y.Map of that shape's fields. One map
 *   per shape means two people changing different fields of the same shape
 *   (one moves it, one recolors it) both keep their change.
 * - A shape's `text` is a Y.Text inside its map, created with the shape, so
 *   two people typing in it merge character by character. Formatting on
 *   parts of it (`Shape.textRuns`) is the Y.Text's own formatting
 *   attributes, so it merges the same way.
 * - A reaction is a key of its own in the shape's map,
 *   `reaction.<name>.<user>`, set to true: adding and removing your own
 *   reaction never touches anyone else's.
 * - An image's map holds only its file's id (`asset`); the file is kept by
 *   the realtime server (docs/decisions/0008-images-and-reactions.md).
 * - `meta`: Y.Map with `schemaVersion`.
 */
import * as Y from "yjs";
import {
  ASSET_ID,
  holdsText,
  REACTIONS,
  reactionKey,
  readShape,
  SCHEMA_VERSION,
  type Shape,
  type ShapeId,
  USER_ID,
} from "./shape";
import type { DocStore, Origin, ShapeChange, TextEdit, Tx } from "./store";
import type { MarkPatch, TextMarks, TextRun } from "./text-runs";

/** Transaction origin for this user's edits; the undo manager tracks only these. */
const LOCAL_ORIGIN = Symbol("niro.local");
const MIGRATION_ORIGIN = Symbol("niro.migration");

type YShape = Y.Map<unknown>;

/**
 * Migrations, keyed by the version they upgrade from. Each one runs inside a
 * transaction and must be a pure function of the stored data, so two clients
 * migrating the same board at once write identical values.
 */
const MIGRATIONS: Record<number, (shapes: Y.Map<YShape>) => void> = {};

export interface YDocStoreOptions {
  /** Edits closer together than this merge into one undo step. Default 500 ms. */
  captureTimeout?: number;
  /** View only: edits, undo and redo are ignored, and nothing is ever written. */
  readOnly?: boolean;
}

export interface YDocStore extends DocStore {
  /**
   * Stops edits, or allows them again: for when the server says the board
   * takes no more changes (it's full). Listeners are called with no changes.
   */
  setReadOnly(readOnly: boolean): void;
  /**
   * Puts the board back as it was in `state` (a saved version: the whole
   * document as one Yjs update) by editing the live board to match: a new
   * change that collaborators receive and that undo reverts, not a rewind.
   * Returns false, changing nothing, when the board is read-only or `state`
   * is from a newer version of Niro.
   */
  restore(state: Uint8Array): boolean;
  destroy(): void;
}

/**
 * Wraps `doc` in a `DocStore`. Create it after the doc has loaded what it
 * can (IndexedDB, then the server), because it migrates whatever is there.
 *
 * An empty doc is never stamped with a schema version on open, only with its
 * first edit: a client that opened a board before the server's copy arrived
 * would otherwise write its own version concurrently with the stored one,
 * and the older number could win.
 */
export function createYDocStore(doc: Y.Doc, options: YDocStoreOptions = {}): YDocStore {
  const shapes = doc.getMap<YShape>("shapes");
  const meta = doc.getMap<unknown>("meta");
  if (!options.readOnly) migrate(doc, shapes, meta);

  let refused = false;
  const isReadOnly = () => {
    if (options.readOnly || refused) return true;
    const version = meta.get("schemaVersion");
    // No version yet: a new board, which the first edit stamps.
    return version !== undefined && !isKnownVersion(version);
  };

  const captureTimeout = options.captureTimeout ?? 500;
  const undoManager = new Y.UndoManager(shapes, {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout,
  });

  const cache = new Map<ShapeId, Shape>();
  const read = (id: string): Shape | null => {
    const value = shapes.get(id);
    if (!(value instanceof Y.Map)) return null;
    const raw = value.toJSON();
    const text = value.get("text");
    if (text instanceof Y.Text) {
      const runs = runsOf(text);
      if (runs) raw.textRuns = runs;
    }
    return readShape(id, raw);
  };
  for (const id of shapes.keys()) {
    const shape = read(id);
    if (shape) cache.set(shape.id, shape);
  }

  // Shapes touched by the current transaction. Observers run before the undo
  // manager records the transaction, so listeners are called later, from
  // `afterTransactionCleanup`, when `canUndo()` is already up to date.
  const touched = new Set<string>();
  const textEdits = new Map<string, TextEdit[]>();
  const onDeepChange = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
    for (const event of events) {
      if (event.target === shapes) {
        for (const key of (event as Y.YMapEvent<YShape>).keysChanged) touched.add(key);
        continue;
      }
      const id = event.path[0];
      if (typeof id !== "string") continue;
      touched.add(id);
      // Read now: a Yjs event's delta can't be worked out after its handlers return.
      if (event.target instanceof Y.Text) textEdits.set(id, editsOf(event.delta));
    }
  };
  shapes.observeDeep(onDeepChange);

  const listeners = new Set<(changes: readonly ShapeChange[], origin: Origin) => void>();
  const onAfterTransaction = (transaction: Y.Transaction) => {
    if (touched.size === 0) return;
    const changes: ShapeChange[] = [];
    for (const id of touched) {
      const previous = cache.get(id as ShapeId);
      const shape = read(id);
      if (shape) cache.set(shape.id, shape);
      else cache.delete(id as ShapeId);
      const edits = textEdits.get(id);
      if (shape && previous)
        changes.push(
          edits
            ? { kind: "updated", shape, previous, textEdits: edits }
            : { kind: "updated", shape, previous },
        );
      else if (shape) changes.push({ kind: "added", shape });
      else if (previous) changes.push({ kind: "removed", previous });
    }
    touched.clear();
    textEdits.clear();
    if (changes.length === 0) return;
    const o = transaction.origin;
    const origin: Origin =
      o === LOCAL_ORIGIN || o === MIGRATION_ORIGIN || o === undoManager ? "local" : "remote";
    for (const listener of listeners) listener(changes, origin);
  };
  doc.on("afterTransactionCleanup", onAfterTransaction);

  /** A shape's Y.Text, made if it's from before text existed (schema 1). */
  const textOf = (id: ShapeId): Y.Text | null => {
    const map = shapes.get(id);
    const shape = cache.get(id);
    if (!(map instanceof Y.Map) || !shape || !holdsText(shape.type)) return null;
    let text = map.get("text");
    if (!(text instanceof Y.Text)) {
      // Two people starting to type in it at the same moment would race
      // here; new shapes can't.
      text = new Y.Text(typeof text === "string" ? text : "");
      map.set("text", text);
    }
    return text as Y.Text;
  };

  const tx: Tx = {
    add(shape) {
      // A copy starts with no reactions.
      const { id, text, points, from, to, asset, reactions: _, textRuns, ...fields } = shape;
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(fields)) map.set(key, value);
      if (shape.type === "image" && asset !== undefined && ASSET_ID.test(asset))
        map.set("asset", asset);
      // Fields most shapes don't use are left out rather than stored empty.
      if (points.length > 0) map.set("points", [...points]);
      if (from !== null) map.set("from", from);
      if (to !== null) map.set("to", to);
      // Created now, even empty: a Y.Text two people each created later would
      // be two values for one key, and only one would survive.
      const ytext = holdsText(shape.type) ? new Y.Text(text) : null;
      if (ytext) map.set("text", ytext);
      shapes.set(id, map);
      // Formatted once in the document: a Y.Text not yet in one can't be.
      if (ytext && textRuns) {
        let at = 0;
        for (const run of textRuns) {
          if (Object.keys(run.marks).length > 0) ytext.format(at, run.length, { ...run.marks });
          at += run.length;
        }
      }
    },
    update(id, patch) {
      const map = shapes.get(id);
      if (!(map instanceof Y.Map)) return;
      for (const [key, value] of Object.entries(patch)) {
        // A whole shape passed as a patch must not replace its Y.Text with a
        // string, or rewrite a stroke's points.
        if (key === "text" || key === "points" || key === "asset" || key === "reactions") continue;
        if (value !== undefined && map.get(key) !== value) map.set(key, value);
      }
    },
    remove(id) {
      shapes.delete(id);
    },
    react(id, reaction, user, on) {
      const map = shapes.get(id);
      if (!(map instanceof Y.Map) || !Object.hasOwn(REACTIONS, reaction) || !USER_ID.test(user))
        return;
      const key = reactionKey(reaction, user);
      if (on && map.get(key) !== true) map.set(key, true);
      else if (!on && map.has(key)) map.delete(key);
    },
    editText(id, index, deleteCount, insert, marks) {
      const ytext = textOf(id);
      if (!ytext) return;
      const at = Math.max(0, Math.min(Math.trunc(index), ytext.length));
      const remove = Math.max(0, Math.min(Math.trunc(deleteCount), ytext.length - at));
      if (remove > 0) ytext.delete(at, remove);
      // Given attributes (even none), Yjs formats the insert with exactly
      // those, not with whatever surrounds it.
      if (insert.length > 0) ytext.insert(at, insert, { ...marks });
    },
    formatText(id, index, length, patch) {
      const ytext = textOf(id);
      if (!ytext) return;
      const at = Math.max(0, Math.min(Math.trunc(index), ytext.length));
      const n = Math.max(0, Math.min(Math.trunc(length), ytext.length - at));
      if (n > 0 && Object.keys(patch).length > 0) ytext.format(at, n, { ...patch });
    },
  };

  return {
    get readOnly() {
      return isReadOnly();
    },
    get: (id) => cache.get(id),
    all: () => cache.values(),
    transact(fn) {
      if (isReadOnly()) return;
      // The stored board may have arrived after the store was created (a
      // slow first sync). Bring its version up first, in a transaction of
      // its own so undo never reverts it.
      migrate(doc, shapes, meta);
      doc.transact(() => {
        if (!meta.has("schemaVersion")) meta.set("schemaVersion", SCHEMA_VERSION);
        fn(tx);
      }, LOCAL_ORIGIN);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkpoint: () => undoManager.stopCapturing(),
    holdStep() {
      // UndoManager merges a change into the open step when it comes within
      // `captureTimeout` of the last; a pointer held still writes nothing.
      undoManager.stopCapturing();
      undoManager.captureTimeout = Number.POSITIVE_INFINITY;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        undoManager.captureTimeout = captureTimeout;
        undoManager.stopCapturing();
      };
    },
    undo() {
      if (!isReadOnly()) undoManager.undo();
    },
    redo() {
      if (!isReadOnly()) undoManager.redo();
    },
    canUndo: () => !isReadOnly() && undoManager.canUndo(),
    canRedo: () => !isReadOnly() && undoManager.canRedo(),
    restore(state) {
      if (isReadOnly()) return false;
      const saved = new Y.Doc();
      try {
        Y.applyUpdate(saved, state);
        const savedShapes = saved.getMap<YShape>("shapes");
        const savedMeta = saved.getMap<unknown>("meta");
        const version = savedMeta.get("schemaVersion");
        if (version !== undefined && !isKnownVersion(version)) return false;
        migrate(saved, savedShapes, savedMeta);
        migrate(doc, shapes, meta);
        undoManager.stopCapturing();
        doc.transact(() => {
          if (!meta.has("schemaVersion")) meta.set("schemaVersion", SCHEMA_VERSION);
          for (const id of [...shapes.keys()]) if (!savedShapes.has(id)) shapes.delete(id);
          for (const [id, source] of savedShapes) {
            const target = shapes.get(id);
            if (target instanceof Y.Map) copyFields(source, target);
            else {
              shapes.set(id, copyFields(source, new Y.Map<unknown>()));
              flushRuns();
            }
          }
        }, LOCAL_ORIGIN);
        undoManager.stopCapturing();
        return true;
      } catch {
        // Bytes that aren't a Yjs update.
        return false;
      } finally {
        saved.destroy();
      }
    },
    setReadOnly(readOnly) {
      if (readOnly === refused) return;
      refused = readOnly;
      for (const listener of listeners) listener([], "remote");
    },
    destroy() {
      undoManager.destroy();
      shapes.unobserveDeep(onDeepChange);
      doc.off("afterTransactionCleanup", onAfterTransaction);
      listeners.clear();
    },
  };
}

/**
 * Counts a board's shapes as it changes, without reading them all each
 * time: for the realtime server's shape limit. Call `destroy` when done.
 */
export function countShapes(doc: Y.Doc): { readonly count: number; destroy(): void } {
  const shapes = doc.getMap<unknown>("shapes");
  let count = shapes.size;
  const onChange = (event: Y.YMapEvent<unknown>) => {
    for (const change of event.changes.keys.values()) {
      if (change.action === "add") count++;
      else if (change.action === "delete") count--;
    }
  };
  shapes.observe(onChange);
  return {
    get count() {
      return count;
    },
    destroy: () => shapes.unobserve(onChange),
  };
}

/**
 * A schema version this code can read: a whole number from 1 to the
 * current one. Anything else came from a newer client or a broken one, and
 * the store stays read-only rather than loop from, say, -1e300 upwards.
 */
function isKnownVersion(version: unknown): version is number {
  return (
    Number.isInteger(version) && (version as number) >= 1 && (version as number) <= SCHEMA_VERSION
  );
}

function migrate(doc: Y.Doc, shapes: Y.Map<YShape>, meta: Y.Map<unknown>): void {
  const stored = meta.get("schemaVersion");
  // No version: a new board, stamped by its first edit. A newer or unreadable
  // version: leave the board alone; the store is read-only.
  if (!isKnownVersion(stored) || stored === SCHEMA_VERSION) return;
  let version = stored;
  doc.transact(() => {
    for (; version < SCHEMA_VERSION; version++) MIGRATIONS[version]?.(shapes);
    meta.set("schemaVersion", SCHEMA_VERSION);
  }, MIGRATION_ORIGIN);
}

/**
 * Makes `target` hold what `source` holds, touching only what differs: text
 * is edited (so someone typing in it keeps their cursor), the rest is set.
 */
function copyFields(source: YShape, target: YShape): YShape {
  pendingRuns.length = 0;
  for (const key of [...target.keys()]) if (!source.has(key)) target.delete(key);
  for (const [key, value] of source) {
    const current = target.get(key);
    if (value instanceof Y.Text) {
      const text = value.toString();
      const runs = runsOf(value);
      if (current instanceof Y.Text) {
        replaceText(current, text);
        // Formatting too: cleared, then set as it was, where it differs.
        if (JSON.stringify(runsOf(current)) !== JSON.stringify(runs)) applyRuns(current, runs);
      } else {
        const fresh = new Y.Text(text);
        target.set(key, fresh);
        if (runs && fresh.doc) applyRuns(fresh, runs);
        else if (runs) pendingRuns.push([fresh, runs]);
      }
    } else if (JSON.stringify(current) !== JSON.stringify(value)) {
      target.set(key, value);
    }
  }
  return target;
}

/** Texts `copyFields` made in a map not yet in the document: formatted once it is (`flushRuns`). */
const pendingRuns: Array<[Y.Text, readonly TextRun[]]> = [];

function flushRuns(): void {
  for (const [text, runs] of pendingRuns.splice(0)) applyRuns(text, runs);
}

/** A Y.Text's formatting as runs, or undefined when none of it is formatted. */
function runsOf(text: Y.Text): TextRun[] | undefined {
  const delta = text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
  if (!delta.some((op) => op.attributes && Object.keys(op.attributes).length > 0)) return undefined;
  return delta.map((op) => ({
    length: typeof op.insert === "string" ? op.insert.length : 1,
    marks: (op.attributes ?? {}) as TextMarks,
  }));
}

/** Makes `text`'s formatting `runs` (none when undefined), whatever it was. */
function applyRuns(text: Y.Text, runs: readonly TextRun[] | undefined): void {
  const clear: Record<string, null> = {};
  for (const op of text.toDelta() as Array<{ attributes?: Record<string, unknown> }>)
    for (const key of Object.keys(op.attributes ?? {})) clear[key] = null;
  if (Object.keys(clear).length > 0) text.format(0, text.length, clear);
  let at = 0;
  for (const run of runs ?? []) {
    if (Object.keys(run.marks).length > 0)
      text.format(at, run.length, { ...run.marks } as MarkPatch);
    at += run.length;
  }
}

/** Edits `text` into `to` by replacing only the middle that differs. */
function replaceText(text: Y.Text, to: string): void {
  const from = text.toString();
  if (from === to) return;
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let end = 0;
  while (
    end < from.length - start &&
    end < to.length - start &&
    from[from.length - 1 - end] === to[to.length - 1 - end]
  )
    end++;
  if (from.length - start - end > 0) text.delete(start, from.length - start - end);
  const insert = to.slice(start, to.length - end);
  if (insert.length > 0) text.insert(start, insert);
}

/** A Y.Text change (retain, insert, delete, in order) as edits at positions. */
function editsOf(delta: Y.YEvent<Y.Text>["delta"]): TextEdit[] {
  const edits: TextEdit[] = [];
  let at = 0;
  for (const op of delta) {
    if (op.retain !== undefined) at += op.retain;
    else if (op.delete !== undefined) edits.push({ index: at, deleteCount: op.delete, insert: "" });
    else if (typeof op.insert === "string") {
      edits.push({ index: at, deleteCount: 0, insert: op.insert });
      at += op.insert.length;
    }
  }
  return edits;
}
