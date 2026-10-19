import type { DocStore, Shape, ShapeId, ShapePatch, Tx } from "@niro/doc";
import type { Point } from "./geometry";
import type { Scene } from "./scene";

const ORIGIN: Point = { x: 0, y: 0 };

/**
 * Runs `fn` as one document transaction, with shapes and patches in board
 * coordinates, as the `Scene` draws them.
 *
 * The document stores a shape in a frame where it is in the frame: its
 * `(x, y)` is measured from the top-left of the innermost frame it's in.
 * Moving a frame then writes the frame alone, and what's in it follows on
 * every client, whatever else those clients are doing to it at the time
 * (see docs/decisions/0006-groups-and-frames.md). Engine code never sees
 * stored positions: it reads the scene and writes through here, and this
 * is the one place that turns board positions into stored ones.
 */
export function transact(doc: DocStore, scene: Scene, fn: (tx: Tx) => void): void {
  doc.transact((tx) => {
    const batch = new BoardTx(scene);
    fn(batch);
    batch.commit(tx);
  });
}

/** Collects one transaction's edits, then writes them with stored positions. */
class BoardTx implements Tx {
  private readonly added = new Map<ShapeId, Shape>();
  private readonly updates = new Map<ShapeId, ShapePatch>();
  private readonly texts: Array<[ShapeId, number, number, string]> = [];
  private readonly removed = new Set<ShapeId>();
  /** Where each shape is on the board once the batch is in, worked out as needed. */
  private readonly after = new Map<ShapeId, Point>();
  private readonly working = new Set<ShapeId>();

  constructor(private readonly scene: Scene) {}

  add(shape: Shape): void {
    this.added.set(shape.id, shape);
  }

  update(id: ShapeId, patch: ShapePatch): void {
    const added = this.added.get(id);
    if (added) this.added.set(id, { ...added, ...patch });
    else this.updates.set(id, { ...this.updates.get(id), ...patch });
  }

  editText(id: ShapeId, index: number, deleteCount: number, insert: string): void {
    this.texts.push([id, index, deleteCount, insert]);
  }

  remove(id: ShapeId): void {
    this.removed.add(id);
  }

  commit(tx: Tx): void {
    for (const shape of this.added.values()) tx.add({ ...shape, ...this.stored(shape.id) });
    for (const [id, patch] of this.updates) {
      if (this.removed.has(id)) continue;
      tx.update(id, this.needsPosition(id) ? { ...patch, ...this.stored(id) } : patch);
    }
    // Shapes in a group that moved into or out of a frame now measure from
    // a different frame, though nothing in the batch names them.
    for (const id of this.regrouped()) {
      if (!this.updates.has(id) && !this.removed.has(id) && this.rehomed(id))
        tx.update(id, this.stored(id));
    }
    for (const [id, index, deleteCount, insert] of this.texts)
      tx.editText(id, index, deleteCount, insert);
    for (const id of this.removed) tx.remove(id);
  }

  private parentAfter(id: ShapeId): ShapeId | null {
    const patched = this.updates.get(id)?.parentId;
    if (patched !== undefined) return patched;
    return this.added.get(id)?.parentId ?? this.scene.parentOf(id);
  }

  /** The innermost frame shape `id` will be in. */
  private frameAfter(id: ShapeId): ShapeId | null {
    const seen = new Set<ShapeId>([id]);
    for (let at = this.parentAfter(id); at !== null; at = this.parentAfter(at)) {
      // A cycle the batch would make: the scene breaks it, at the top level.
      if (seen.has(at)) return null;
      seen.add(at);
      const type = this.added.get(at)?.type ?? this.scene.get(at)?.type;
      if (type === "frame") return at;
    }
    return null;
  }

  /** True when shape `id` will measure from a different frame than it does now. */
  private rehomed(id: ShapeId): boolean {
    return this.frameAfter(id) !== this.scene.frameOf(id);
  }

  private needsPosition(id: ShapeId): boolean {
    const patch = this.updates.get(id);
    return (
      this.scene.has(id) &&
      ((patch !== undefined && (patch.x !== undefined || patch.y !== undefined)) ||
        this.rehomed(id))
    );
  }

  /** Where shape `id` will be on the board. */
  private boardAfter(id: ShapeId): Point {
    const known = this.after.get(id);
    if (known) return known;
    const drawn = this.scene.get(id);
    // Going round in circles: leave it where it is.
    if (this.working.has(id)) return drawn ?? ORIGIN;
    this.working.add(id);
    let at: Point;
    const added = this.added.get(id);
    const patch = this.updates.get(id);
    const stored = this.scene.storedShape(id);
    if (added) at = { x: added.x, y: added.y };
    else if (!drawn || !stored) at = ORIGIN;
    else if (patch?.x !== undefined || patch?.y !== undefined)
      at = { x: patch.x ?? drawn.x, y: patch.y ?? drawn.y };
    // Moving into or out of a frame doesn't move it on the board.
    else if (this.rehomed(id)) at = { x: drawn.x, y: drawn.y };
    else {
      // Otherwise it goes wherever its frame goes.
      const origin = this.originAfter(this.frameAfter(id));
      at = { x: stored.x + origin.x, y: stored.y + origin.y };
    }
    this.working.delete(id);
    this.after.set(id, at);
    return at;
  }

  private originAfter(frame: ShapeId | null): Point {
    return frame === null ? ORIGIN : this.boardAfter(frame);
  }

  /** Shape `id`'s stored position: where it will be on the board, from its frame's top-left. */
  private stored(id: ShapeId): Pick<Shape, "x" | "y"> {
    const at = this.boardAfter(id);
    const origin = this.originAfter(this.frameAfter(id));
    const now = this.scene.storedShape(id);
    return { x: keep(at.x - origin.x, now?.x), y: keep(at.y - origin.y, now?.y) };
  }

  /** Everything in groups the batch moves to a new parent, down to (and including) frames. */
  private regrouped(): ShapeId[] {
    const result: ShapeId[] = [];
    const visit = (group: ShapeId) => {
      for (const child of this.scene.childrenOf(group)) {
        result.push(child);
        if (this.scene.get(child)?.type === "group") visit(child);
      }
    };
    for (const [id, patch] of this.updates) {
      if (patch.parentId !== undefined && this.scene.get(id)?.type === "group") visit(id);
    }
    return result;
  }
}

/**
 * `value`, or what's stored now if they differ only by rounding: adding a
 * frame's position and taking it away again can come out a hair off, and
 * that would write a change to a shape that didn't move.
 */
function keep(value: number, stored: number | undefined): number {
  return stored !== undefined && Math.abs(value - stored) <= 1e-9 * Math.max(1, Math.abs(stored))
    ? stored
    : value;
}
