import { compareOrder, type DocStore, type Shape, type ShapeChange, type ShapeId } from "@niro/doc";
import type { Box, Point } from "./geometry";
import { hitShape, shapeIntersectsBox } from "./shapes";

/**
 * The engine's read model of the document: every shape plus the draw order.
 *
 * It is rebuilt from `DocStore` change batches, never written to directly.
 * Hit testing and marquee selection scan every shape; P5 replaces the scans
 * with a spatial index.
 */
export class Scene {
  private readonly shapes = new Map<ShapeId, Shape>();
  private order: Shape[] | null = null;

  constructor(doc: DocStore) {
    for (const shape of doc.all()) this.shapes.set(shape.id, shape);
  }

  apply(changes: readonly ShapeChange[]): void {
    let reordered = false;
    for (const change of changes) {
      if (change.kind === "removed") this.shapes.delete(change.previous.id);
      else this.shapes.set(change.shape.id, change.shape);
      if (change.kind !== "updated" || change.shape.index !== change.previous.index)
        reordered = true;
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

  /** Shapes in draw order, bottom first. */
  ordered(): readonly Shape[] {
    this.order ??= [...this.shapes.values()].sort(compareOrder);
    return this.order;
  }

  /** The topmost shape under `p`, if any. */
  hit(p: Point, tolerance: number): Shape | undefined {
    const order = this.ordered();
    for (let i = order.length - 1; i >= 0; i--) {
      const shape = order[i] as Shape;
      if (hitShape(shape, p, tolerance)) return shape;
    }
    return undefined;
  }

  /** Every shape overlapping `box`, in draw order. */
  inBox(box: Box): Shape[] {
    return this.ordered().filter((shape) => shapeIntersectsBox(shape, box));
  }
}
