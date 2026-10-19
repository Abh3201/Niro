/**
 * `DocStore` on Yjs. Only apps import this module; the engine sees the
 * interface alone.
 *
 * Layout of the Y.Doc:
 * - `shapes`: Y.Map from shape id to a Y.Map of that shape's fields. One map
 *   per shape means two people changing different fields of the same shape
 *   (one moves it, one recolors it) both keep their change.
 * - `meta`: Y.Map with `schemaVersion`.
 */
import * as Y from "yjs";
import { readShape, SCHEMA_VERSION, type Shape, type ShapeId } from "./shape";
import type { DocStore, Origin, ShapeChange, Tx } from "./store";

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
}

export interface YDocStore extends DocStore {
  destroy(): void;
}

/**
 * Wraps `doc` in a `DocStore`. Create it after the doc has loaded its stored
 * state (IndexedDB, then the server), because it migrates whatever is
 * there: migrating an empty doc that hasn't loaded yet would write a schema
 * version that then races with the real one.
 */
export function createYDocStore(doc: Y.Doc, options: YDocStoreOptions = {}): YDocStore {
  const shapes = doc.getMap<YShape>("shapes");
  const meta = doc.getMap<unknown>("meta");
  migrate(doc, shapes, meta);

  const isReadOnly = () => {
    const version = meta.get("schemaVersion");
    return typeof version !== "number" || version > SCHEMA_VERSION;
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
  const onDeepChange = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
    for (const event of events) {
      if (event.target === shapes) {
        for (const key of (event as Y.YMapEvent<YShape>).keysChanged) touched.add(key);
      } else {
        const id = event.path[0];
        if (typeof id === "string") touched.add(id);
      }
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
      if (shape && previous) changes.push({ kind: "updated", shape, previous });
      else if (shape) changes.push({ kind: "added", shape });
      else if (previous) changes.push({ kind: "removed", previous });
    }
    touched.clear();
    if (changes.length === 0) return;
    const o = transaction.origin;
    const origin: Origin =
      o === LOCAL_ORIGIN || o === MIGRATION_ORIGIN || o === undoManager ? "local" : "remote";
    for (const listener of listeners) listener(changes, origin);
  };
  doc.on("afterTransactionCleanup", onAfterTransaction);

  const tx: Tx = {
    add(shape) {
      const { id, ...fields } = shape;
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(fields)) map.set(key, value);
      shapes.set(id, map);
    },
    update(id, patch) {
      const map = shapes.get(id);
      if (!(map instanceof Y.Map)) return;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && map.get(key) !== value) map.set(key, value);
      }
    },
    remove(id) {
      shapes.delete(id);
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
      doc.transact(() => fn(tx), LOCAL_ORIGIN);
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
    destroy() {
      undoManager.destroy();
      shapes.unobserveDeep(onDeepChange);
      doc.off("afterTransactionCleanup", onAfterTransaction);
      listeners.clear();
    },
  };
}

function migrate(doc: Y.Doc, shapes: Y.Map<YShape>, meta: Y.Map<unknown>): void {
  const stored = meta.get("schemaVersion");
  // A newer or unreadable version: leave the board alone; the store is read-only.
  if (stored !== undefined && (typeof stored !== "number" || stored >= SCHEMA_VERSION)) return;
  // Boards from before versioning existed don't exist, so a missing version
  // means a new board.
  let version = stored ?? SCHEMA_VERSION;
  doc.transact(() => {
    for (; version < SCHEMA_VERSION; version++) MIGRATIONS[version]?.(shapes);
    meta.set("schemaVersion", SCHEMA_VERSION);
  }, MIGRATION_ORIGIN);
}
