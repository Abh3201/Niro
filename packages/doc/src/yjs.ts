/**
 * `DocStore` on Yjs. Only apps import this module; the engine sees the
 * interface alone.
 *
 * Layout of the Y.Doc:
 * - `shapes`: Y.Map from shape id to a Y.Map of that shape's fields. One map
 *   per shape means two people changing different fields of the same shape
 *   (one moves it, one recolors it) both keep their change.
 * - A shape's `text` is a Y.Text inside its map, created with the shape, so
 *   two people typing in it merge character by character.
 * - `meta`: Y.Map with `schemaVersion`.
 */
import * as Y from "yjs";
import { holdsText, readShape, SCHEMA_VERSION, type Shape, type ShapeId } from "./shape";
import type { DocStore, Origin, ShapeChange, TextEdit, Tx } from "./store";

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
    return version !== undefined && (typeof version !== "number" || version > SCHEMA_VERSION);
  };

  const undoManager = new Y.UndoManager(shapes, {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: options.captureTimeout ?? 500,
  });

  const cache = new Map<ShapeId, Shape>();
  const read = (id: string): Shape | null => {
    const value = shapes.get(id);
    return value instanceof Y.Map ? readShape(id, value.toJSON()) : null;
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

  const tx: Tx = {
    add(shape) {
      const { id, text, points, from, to, ...fields } = shape;
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(fields)) map.set(key, value);
      // Fields most shapes don't use are left out rather than stored empty.
      if (points.length > 0) map.set("points", [...points]);
      if (from !== null) map.set("from", from);
      if (to !== null) map.set("to", to);
      // Created now, even empty: a Y.Text two people each created later would
      // be two values for one key, and only one would survive.
      if (holdsText(shape.type)) map.set("text", new Y.Text(text));
      shapes.set(id, map);
    },
    update(id, patch) {
      const map = shapes.get(id);
      if (!(map instanceof Y.Map)) return;
      for (const [key, value] of Object.entries(patch)) {
        // A whole shape passed as a patch must not replace its Y.Text with a
        // string, or rewrite a stroke's points.
        if (key === "text" || key === "points") continue;
        if (value !== undefined && map.get(key) !== value) map.set(key, value);
      }
    },
    remove(id) {
      shapes.delete(id);
    },
    editText(id, index, deleteCount, insert) {
      const map = shapes.get(id);
      const shape = cache.get(id);
      if (!(map instanceof Y.Map) || !shape || !holdsText(shape.type)) return;
      let text = map.get("text");
      if (!(text instanceof Y.Text)) {
        // A shape from before text existed (schema 1). Two people starting to
        // type in it at the same moment would race here; new shapes can't.
        text = new Y.Text(typeof text === "string" ? text : "");
        map.set("text", text);
      }
      const ytext = text as Y.Text;
      const at = Math.max(0, Math.min(Math.trunc(index), ytext.length));
      const remove = Math.max(0, Math.min(Math.trunc(deleteCount), ytext.length - at));
      if (remove > 0) ytext.delete(at, remove);
      if (insert.length > 0) ytext.insert(at, insert);
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
    undo() {
      if (!isReadOnly()) undoManager.undo();
    },
    redo() {
      if (!isReadOnly()) undoManager.redo();
    },
    canUndo: () => !isReadOnly() && undoManager.canUndo(),
    canRedo: () => !isReadOnly() && undoManager.canRedo(),
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

function migrate(doc: Y.Doc, shapes: Y.Map<YShape>, meta: Y.Map<unknown>): void {
  const stored = meta.get("schemaVersion");
  // No version: a new board, stamped by its first edit. A newer or unreadable
  // version: leave the board alone; the store is read-only.
  if (typeof stored !== "number" || stored >= SCHEMA_VERSION) return;
  let version = stored;
  doc.transact(() => {
    for (; version < SCHEMA_VERSION; version++) MIGRATIONS[version]?.(shapes);
    meta.set("schemaVersion", SCHEMA_VERSION);
  }, MIGRATION_ORIGIN);
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
