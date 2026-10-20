import {
  type DocStore,
  editRuns,
  formatRuns,
  type Origin,
  type Shape,
  type ShapeChange,
  type ShapeId,
  type Tx,
} from "@niro/doc";

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
        editText(id, index, deleteCount, insert, marks) {
          const previous = shapes.get(id);
          if (!previous) return;
          const { text, runs } = editRuns(
            previous.text,
            previous.textRuns,
            index,
            deleteCount,
            insert,
            marks,
          );
          const { textRuns: _, ...rest } = previous;
          const shape: Shape = { ...rest, text, ...(runs && { textRuns: runs }) };
          shapes.set(id, shape);
          changes.push({ kind: "updated", shape, previous });
        },
        formatText(id, index, length, patch) {
          const previous = shapes.get(id);
          if (!previous) return;
          const runs = formatRuns(previous.text, previous.textRuns, index, length, patch);
          const { textRuns: _, ...rest } = previous;
          const shape: Shape = { ...rest, ...(runs && { textRuns: runs }) };
          shapes.set(id, shape);
          changes.push({ kind: "updated", shape, previous });
        },
        react(id, reaction, user, on) {
          const previous = shapes.get(id);
          if (!previous) return;
          const users = previous.reactions?.[reaction] ?? [];
          if (users.includes(user) === on) return;
          const next = on ? [...users, user].sort() : users.filter((u) => u !== user);
          const { [reaction]: _, ...others } = previous.reactions ?? {};
          const reactions = next.length > 0 ? { ...others, [reaction]: next } : others;
          const { reactions: __, ...rest } = previous;
          const shape: Shape = Object.keys(reactions).length > 0 ? { ...rest, reactions } : rest;
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
    holdStep: () => () => {},
    undo() {},
    redo() {},
    canUndo: () => false,
    canRedo: () => false,
  };
}
