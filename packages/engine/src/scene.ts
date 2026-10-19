import { compareOrder, type DocStore, type Shape, type ShapeChange, type ShapeId } from "@niro/doc";
import { resolveArrow } from "./arrows";
import type { Box, Point } from "./geometry";
import { hitShape, shapeIntersectsBox } from "./shapes";

/**
 * The engine's read model of the document: every shape plus the draw order.
 *
 * It is rebuilt from `DocStore` change batches, never written to directly.
 * Shapes are as drawn: an arrow attached to shapes has its ends where those
 * shapes are now, which is not what the document stores (see `arrows.ts`).
 * Hit testing and marquee selection scan every shape; P5 replaces the scans
 * with a spatial index.
 */
export class Scene {
  /** Shapes as drawn. */
  private readonly shapes = new Map<ShapeId, Shape>();
  /** Arrows as stored, to place their ends again when what they're attached to changes. */
  private readonly storedArrows = new Map<ShapeId, Shape>();
  /** For each shape, the arrows attached to it, whether or not it exists. */
  private readonly attached = new Map<ShapeId, Set<ShapeId>>();
  private order: Shape[] | null = null;

  constructor(doc: DocStore) {
    this.apply([...doc.all()].map((shape) => ({ kind: "added" as const, shape })));
  }

  apply(changes: readonly ShapeChange[]): void {
    let reordered = false;
    /** Arrows whose ends need placing again. */
    const arrows = new Set<ShapeId>();
    const touched = (id: ShapeId) => {
      for (const arrow of this.attached.get(id) ?? []) arrows.add(arrow);
    };
    for (const change of changes) {
      if (change.kind !== "added") this.unlink(change.previous);
      if (change.kind === "removed") {
        this.shapes.delete(change.previous.id);
        touched(change.previous.id);
      } else {
        const { shape } = change;
        this.link(shape);
        if (shape.type === "arrow") arrows.add(shape.id);
        else this.shapes.set(shape.id, shape);
        touched(shape.id);
      }
      if (change.kind !== "updated" || change.shape.index !== change.previous.index)
        reordered = true;
    }
    for (const id of arrows) {
      const arrow = this.storedArrows.get(id);
      if (arrow)
        this.shapes.set(
          id,
          resolveArrow(arrow, (target) => this.shapes.get(target)),
        );
    }
    if (reordered) {
      // Rebuilt lazily, on the next read.
      this.order = null;
    } else if (this.order) {
      // A drag changes positions, not the order: swap in the new snapshots
      // instead of sorting again on every frame.
      this.order = this.order.map((shape) => this.shapes.get(shape.id) ?? shape);
    }
  }

  get(id: ShapeId): Shape | undefined {
    return this.shapes.get(id);
  }

  has(id: ShapeId): boolean {
    return this.shapes.has(id);
  }

  get size(): number {
    return this.shapes.size;
  }

  /** The arrows with an end attached to shape `id`. */
  arrowsAttachedTo(id: ShapeId): ShapeId[] {
    return [...(this.attached.get(id) ?? [])];
  }

  /** Shapes in draw order, bottom first. */
  ordered(): readonly Shape[] {
    this.order ??= [...this.shapes.values()].sort(compareOrder);
    return this.order;
  }

  /** The topmost shape under `p` that `accept` takes (any, by default). */
  hit(p: Point, tolerance: number, accept?: (shape: Shape) => boolean): Shape | undefined {
    const order = this.ordered();
    for (let i = order.length - 1; i >= 0; i--) {
      const shape = order[i] as Shape;
      if ((!accept || accept(shape)) && hitShape(shape, p, tolerance)) return shape;
    }
    return undefined;
  }

  /** Every shape overlapping `box`, in draw order. */
  inBox(box: Box): Shape[] {
    return this.ordered().filter((shape) => shapeIntersectsBox(shape, box));
  }

  private link(shape: Shape): void {
    if (shape.type !== "arrow") return;
    this.storedArrows.set(shape.id, shape);
    for (const target of [shape.from, shape.to]) {
      if (target === null) continue;
      let arrows = this.attached.get(target);
      if (!arrows) {
        arrows = new Set();
        this.attached.set(target, arrows);
      }
      arrows.add(shape.id);
    }
  }

  private unlink(shape: Shape): void {
    if (shape.type !== "arrow") return;
    this.storedArrows.delete(shape.id);
    for (const target of [shape.from, shape.to]) {
      if (target === null) continue;
      const arrows = this.attached.get(target);
      arrows?.delete(shape.id);
      if (arrows?.size === 0) this.attached.delete(target);
    }
  }
}
