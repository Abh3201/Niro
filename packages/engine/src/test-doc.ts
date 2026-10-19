import type { DocStore, Origin, Shape, ShapeChange, ShapeId, Tx } from "@niro/doc";

/**
 * A minimal in-memory DocStore for tests, starting with `initial`: the
 * engine must work with any implementation.
 */
export function memoryDoc(initial: readonly Shape[] = []): DocStore {
  const shapes = new Map<ShapeId, Shape>(initial.map((shape) => [shape.id, shape]));
  const listeners = new Set<(changes: readonly ShapeChange[], origin: Origin) => void>();
  return {
    readOnly: false,
    get: (id) => shapes.get(id),
    all: () => shapes.values(),
    transact(fn) {
      const changes: ShapeChange[] = [];
      const tx: Tx = {
        add(shape) {
          shapes.set(shape.id, shape);
          changes.push({ kind: "added", shape });
        },
        update(id, patch) {
          const previous = shapes.get(id);
          if (!previous) return;
          // Like the real store, only fields that differ are written.
          const fields = Object.entries(patch) as [keyof Shape, unknown][];
          if (fields.every(([key, value]) => previous[key] === value)) return;
          const shape = { ...previous, ...patch };
          shapes.set(id, shape);
          changes.push({ kind: "updated", shape, previous });
        },
        editText(id, index, deleteCount, insert) {
          const previous = shapes.get(id);
          if (!previous) return;
          const text = previous.text;
          const shape = {
            ...previous,
            text: text.slice(0, index) + insert + text.slice(index + deleteCount),
          };
          shapes.set(id, shape);
          changes.push({ kind: "updated", shape, previous });
        },
        remove(id) {
          const previous = shapes.get(id);
          if (!previous) return;
          shapes.delete(id);
          changes.push({ kind: "removed", previous });
        },
      };
      fn(tx);
      for (const listener of listeners) listener(changes, "local");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkpoint() {},
    undo() {},
    redo() {},
    canUndo: () => false,
    canRedo: () => false,
  };
}
