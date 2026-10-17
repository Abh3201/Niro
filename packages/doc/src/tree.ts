/**
 * Groups and frames form a tree through each shape's `parentId`. Yjs has no
 * move operation, so two peers can each make a valid move that, merged,
 * creates a cycle: A into B on one peer, B into A on the other (see
 * docs/decisions/0001-sync-library.md).
 *
 * Instead of writing a fix back, which two peers could do differently at the
 * same time, every reader derives the same *effective* parent from the
 * stored data:
 * - a parent that doesn't exist makes the shape top level;
 * - in a cycle, the member with the smallest id becomes top level.
 *
 * The parent graph has one outgoing edge per node, so each connected part has
 * at most one cycle and breaking it at its smallest id doesn't depend on the
 * order shapes are visited in.
 */

interface Parented {
  readonly id: string;
  readonly parentId: string | null;
}

const VISITING = 1;
const DONE = 2;

export function effectiveParents(shapes: Iterable<Parented>): Map<string, string | null> {
  const parent = new Map<string, string | null>();
  const all = [...shapes];
  const ids = new Set(all.map((s) => s.id));
  for (const s of all) {
    parent.set(s.id, s.parentId !== null && ids.has(s.parentId) ? s.parentId : null);
  }

  const state = new Map<string, number>();
  for (const s of all) {
    const path: string[] = [];
    let at: string | null = s.id;
    while (at !== null && state.get(at) !== DONE) {
      if (state.get(at) === VISITING) {
        const cycle = path.slice(path.indexOf(at));
        let breaker = cycle[0] as string;
        for (const id of cycle) if (id < breaker) breaker = id;
        parent.set(breaker, null);
        break;
      }
      state.set(at, VISITING);
      path.push(at);
      at = parent.get(at) ?? null;
    }
    for (const id of path) state.set(id, DONE);
  }
  return parent;
}
