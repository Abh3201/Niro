import {
  compareOrder,
  type DocStore,
  effectiveParents,
  type Shape,
  type ShapeChange,
  type ShapeId,
} from "@niro/doc";
import RBush from "rbush";
import { resolveArrow } from "./arrows";
import { type Box, type Point, unionBoxes } from "./geometry";
import { hitShape, shapeBounds, shapeExtent, shapeIntersectsBox, toShapeFrame } from "./shapes";

const NO_FRAMES: readonly ShapeId[] = [];

/** A shape's entry in the spatial index. */
interface Indexed {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  readonly id: ShapeId;
}

export interface SceneOptions {
  /**
   * The box a shape covers when drawn: its outline, plus whatever is drawn
   * past it (line caps, shadows, text that spills out, a frame's name). The
   * spatial index uses it, so anything outside it may be left undrawn.
   * It must hold `shapeExtent`, or hit tests would miss. By default, it is
   * `shapeExtent`.
   */
  extent?: (shape: Shape) => Box;
}

/**
 * The engine's read model of the document: every shape, the tree that groups
 * and frames make, and the draw order.
 *
 * It is rebuilt from `DocStore` change batches, never written to directly.
 * Shapes are as drawn, on the board, which isn't always what the document
 * stores: a shape in a frame stores where it is in the frame (see
 * `board-tx.ts`, which turns edits back), an arrow attached to shapes has its
 * ends where those shapes are now (see `arrows.ts`), and a group is as big as
 * what's in it.
 *
 * Shapes are drawn depth first: each shape, then what's in it, siblings in
 * `(index, id)` order.
 *
 * An R-tree (rbush) holds every shape's drawn box, so drawing, hit testing
 * and marquee selection look only at shapes near where they're looking,
 * then put them in draw order by each shape's place in it.
 */
export class Scene {
  /** Shapes as stored. */
  private readonly stored = new Map<ShapeId, Shape>();
  /** Shapes as drawn. */
  private readonly shapes = new Map<ShapeId, Shape>();
  /** For each shape, the arrows attached to it, whether or not it exists. */
  private readonly attached = new Map<ShapeId, Set<ShapeId>>();
  /** Each shape's effective parent: cycles broken, parents that can't hold shapes ignored. */
  private parents = new Map<ShapeId, ShapeId | null>();
  /** Each parent's children (top level under `null`), in draw order. */
  private children = new Map<ShapeId | null, ShapeId[]>();
  private order: Shape[] | null = null;
  /** For each shape inside frames, those frames, outermost first. */
  private frames = new Map<ShapeId, readonly ShapeId[]>();
  /** Each shape's place in `order`. */
  private ranks: Map<ShapeId, number> | null = null;
  private readonly tree = new RBush<Indexed>();
  private readonly indexed = new Map<ShapeId, Indexed>();
  /** Shapes drawn differently since the index was last brought up to date. */
  private readonly unindexed = new Set<ShapeId>();
  private readonly extent: (shape: Shape) => Box;

  constructor(doc: DocStore, options: SceneOptions = {}) {
    this.extent = options.extent ?? shapeExtent;
    this.apply([...doc.all()].map((shape) => ({ kind: "added" as const, shape })));
  }

  apply(changes: readonly ShapeChange[]): void {
    if (changes.length === 0) return;
    let structural = false;
    const changed = new Set<ShapeId>();
    for (const change of changes) {
      if (change.kind !== "added") this.unlink(change.previous);
      if (change.kind === "removed") {
        const { id } = change.previous;
        this.stored.delete(id);
        this.shapes.delete(id);
        this.unindexed.add(id);
        structural = true;
        continue;
      }
      const { shape } = change;
      this.stored.set(shape.id, shape);
      this.link(shape);
      changed.add(shape.id);
      if (
        change.kind === "added" ||
        shape.parentId !== change.previous.parentId ||
        shape.index !== change.previous.index
      )
        structural = true;
    }

    if (structural) {
      this.rebuildTree();
      this.placeAll();
      this.order = null;
      this.ranks = null;
    } else {
      this.place(changed);
      // A drag changes positions, not the order: swap in the new snapshots
      // instead of walking the tree again on every frame.
      this.order &&= this.order.map((shape) => this.shapes.get(shape.id) ?? shape);
    }
    this.reindex();
  }

  get(id: ShapeId): Shape | undefined {
    return this.shapes.get(id);
  }

  /** Shape `id` as the document stores it: in a frame, where it is in the frame. */
  storedShape(id: ShapeId): Shape | undefined {
    return this.stored.get(id);
  }

  /** The frame whose top-left shape `id`'s stored position is measured from, or null for the board's origin. */
  frameOf(id: ShapeId): ShapeId | null {
    return this.framesAround(id).at(-1) ?? null;
  }

  has(id: ShapeId): boolean {
    return this.shapes.has(id);
  }

  get size(): number {
    return this.shapes.size;
  }

  /** The group or frame shape `id` is in, or null at the top level. */
  parentOf(id: ShapeId): ShapeId | null {
    return this.parents.get(id) ?? null;
  }

  /** What's directly in `parent` (the top level for null), in draw order. */
  childrenOf(parent: ShapeId | null): readonly ShapeId[] {
    return this.children.get(parent) ?? [];
  }

  /** Everything inside shape `id`, at any depth, in draw order. */
  descendantsOf(id: ShapeId): ShapeId[] {
    const result: ShapeId[] = [];
    const visit = (parent: ShapeId) => {
      for (const child of this.childrenOf(parent)) {
        result.push(child);
        visit(child);
      }
    };
    visit(id);
    return result;
  }

  /** The groups and frames shape `id` is in, innermost first. */
  ancestorsOf(id: ShapeId): ShapeId[] {
    const result: ShapeId[] = [];
    for (let at = this.parentOf(id); at !== null; at = this.parentOf(at)) result.push(at);
    return result;
  }

  /** The frames shape `id` is drawn inside, outermost first: it's clipped to each. */
  framesAround(id: ShapeId): readonly ShapeId[] {
    return this.frames.get(id) ?? NO_FRAMES;
  }

  /** The arrows with an end attached to shape `id`. */
  arrowsAttachedTo(id: ShapeId): ShapeId[] {
    return [...(this.attached.get(id) ?? [])];
  }

  /** Shapes in draw order, bottom first. */
  ordered(): readonly Shape[] {
    if (!this.order) {
      const order: Shape[] = [];
      const visit = (parent: ShapeId | null) => {
        for (const id of this.childrenOf(parent)) {
          const shape = this.shapes.get(id);
          if (shape) order.push(shape);
          visit(id);
        }
      };
      visit(null);
      this.order = order;
    }
    return this.order;
  }

  /** Shapes whose drawn box overlaps `box`, in draw order: what to draw for a view of `box`. */
  visible(box: Box): Shape[] {
    const order = this.ordered();
    const found = this.tree.search(box);
    if (found.length === order.length) return [...order];
    const ranks = this.rankMap();
    const marked = new Uint8Array(order.length);
    for (const entry of found) {
      const rank = ranks.get(entry.id);
      if (rank !== undefined) marked[rank] = 1;
    }
    const result: Shape[] = [];
    for (let i = 0; i < order.length; i++) if (marked[i]) result.push(order[i] as Shape);
    return result;
  }

  /** Shapes whose drawn box overlaps `box`, topmost first. For looking at a few shapes. */
  private near(box: Box): Shape[] {
    const order = this.ordered();
    const ranks = this.rankMap();
    const found: number[] = [];
    for (const entry of this.tree.search(box)) {
      const rank = ranks.get(entry.id);
      if (rank !== undefined) found.push(rank);
    }
    return found.sort((a, b) => b - a).map((rank) => order[rank] as Shape);
  }

  /**
   * The topmost shape under `p` that `accept` takes (any, by default). Parts
   * of shapes cut off by the frames they're in can't be hit, and the inside
   * of a frame hides what's under it without being hit itself: a press
   * there is on the frame's surface, like the board's.
   */
  hit(p: Point, tolerance: number, accept?: (shape: Shape) => boolean): Shape | undefined {
    const around = {
      minX: p.x - tolerance,
      minY: p.y - tolerance,
      maxX: p.x + tolerance,
      maxY: p.y + tolerance,
    };
    for (const shape of this.near(around)) {
      if (hitShape(shape, p, tolerance)) {
        if ((!accept || accept(shape)) && this.visibleAt(shape.id, p)) return shape;
      } else if (shape.type === "frame" && inside(shape, p) && this.visibleAt(shape.id, p)) {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * The topmost frame `p` is inside (and not cut off from by an outer
   * frame), other than those in `exclude`: where a shape put at `p` belongs.
   */
  frameAt(p: Point, exclude: ReadonlySet<ShapeId> = new Set()): ShapeId | null {
    for (const shape of this.near({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y })) {
      if (shape.type !== "frame" || exclude.has(shape.id)) continue;
      if (inside(shape, p) && this.visibleAt(shape.id, p)) return shape.id;
    }
    return null;
  }

  /** Every shape overlapping `box`, in draw order. Groups overlap where what's in them does. */
  inBox(box: Box): Shape[] {
    return this.visible(box).filter((shape) => shapeIntersectsBox(shape, box));
  }

  private rankMap(): Map<ShapeId, number> {
    if (!this.ranks) {
      const ranks = new Map<ShapeId, number>();
      this.ordered().forEach((shape, i) => {
        ranks.set(shape.id, i);
      });
      this.ranks = ranks;
    }
    return this.ranks;
  }

  /** Records how `shape` is drawn now. */
  private draw(shape: Shape): void {
    const before = this.shapes.get(shape.id);
    this.shapes.set(shape.id, shape);
    // Placing everything again (after any change to the tree) mostly puts
    // shapes back where they were: those keep their place in the index.
    if (
      before &&
      before.x === shape.x &&
      before.y === shape.y &&
      before.w === shape.w &&
      before.h === shape.h &&
      before.rotation === shape.rotation &&
      before.text === shape.text
    )
      return;
    this.unindexed.add(shape.id);
  }

  /** Brings the index up to date with how shapes are now drawn. */
  private reindex(): void {
    if (this.unindexed.size === 0) return;
    // Most of the board changed (it just loaded): build the tree in one go.
    if (this.unindexed.size > this.indexed.size / 2) {
      this.tree.clear();
      this.indexed.clear();
      const entries: Indexed[] = [];
      for (const shape of this.shapes.values()) {
        const entry = { ...this.extent(shape), id: shape.id };
        this.indexed.set(shape.id, entry);
        entries.push(entry);
      }
      this.tree.load(entries);
      this.unindexed.clear();
      return;
    }
    for (const id of this.unindexed) {
      const shape = this.shapes.get(id);
      const entry = this.indexed.get(id);
      if (!shape) {
        if (entry) this.tree.remove(entry);
        this.indexed.delete(id);
        continue;
      }
      const box = this.extent(shape);
      if (
        entry &&
        entry.minX === box.minX &&
        entry.minY === box.minY &&
        entry.maxX === box.maxX &&
        entry.maxY === box.maxY
      )
        continue;
      if (entry) this.tree.remove(entry);
      const next = { ...box, id };
      this.indexed.set(id, next);
      this.tree.insert(next);
    }
    this.unindexed.clear();
  }

  /** True when `p` isn't cut off by any frame shape `id` is in. */
  private visibleAt(id: ShapeId, p: Point): boolean {
    for (const frameId of this.framesAround(id)) {
      const frame = this.shapes.get(frameId);
      if (frame && !inside(frame, p)) return false;
    }
    return true;
  }

  /** Where a stored shape is on the board: moved by the top-left of the frame it's in. */
  private onBoard(shape: Shape): Shape {
    const frameId = this.frameOf(shape.id);
    const frame = frameId === null ? undefined : this.shapes.get(frameId);
    return frame ? { ...shape, x: shape.x + frame.x, y: shape.y + frame.y } : shape;
  }

  /**
   * Places every shape: frames before what's in them, then arrows against
   * the shapes they're attached to, then groups around what's in them.
   */
  private placeAll(): void {
    const arrows: Shape[] = [];
    const groups: ShapeId[] = [];
    const walk = (parent: ShapeId | null) => {
      for (const id of this.childrenOf(parent)) {
        const shape = this.stored.get(id);
        if (!shape) continue;
        if (shape.type === "arrow") arrows.push(shape);
        else if (shape.type !== "group") this.draw(this.onBoard(shape));
        walk(id);
        // After what's in them: inner groups are fitted first.
        if (shape.type === "group") groups.push(id);
      }
    };
    walk(null);
    for (const arrow of arrows) this.placeArrow(arrow);
    for (const id of groups) this.fitGroup(id);
  }

  /** Places shapes whose stored geometry changed, with everything that depends on them. */
  private place(changed: ReadonlySet<ShapeId>): void {
    // A frame that moved takes everything in it along.
    const moved = new Set<ShapeId>();
    for (const id of changed) {
      moved.add(id);
      if (this.stored.get(id)?.type === "frame")
        for (const inside of this.descendantsOf(id)) moved.add(inside);
    }
    const depth = (id: ShapeId) => this.framesAround(id).length;
    for (const id of [...moved].sort((a, b) => depth(a) - depth(b))) {
      const shape = this.stored.get(id);
      if (shape && shape.type !== "arrow" && shape.type !== "group") this.draw(this.onBoard(shape));
    }
    const arrows = new Set<ShapeId>();
    for (const id of moved) {
      if (this.stored.get(id)?.type === "arrow") arrows.add(id);
      for (const arrow of this.attached.get(id) ?? []) arrows.add(arrow);
    }
    for (const id of arrows) {
      const arrow = this.stored.get(id);
      if (arrow) this.placeArrow(arrow);
      moved.add(id);
    }
    this.fitGroups(moved);
  }

  private placeArrow(arrow: Shape): void {
    this.draw(resolveArrow(this.onBoard(arrow), (target) => this.shapes.get(target)));
  }

  private rebuildTree(): void {
    this.parents = effectiveParents(this.stored.values()) as Map<ShapeId, ShapeId | null>;
    this.children = new Map();
    for (const [id, parent] of this.parents) {
      let siblings = this.children.get(parent);
      if (!siblings) {
        siblings = [];
        this.children.set(parent, siblings);
      }
      siblings.push(id);
    }
    const byOrder = (a: ShapeId, b: ShapeId) =>
      compareOrder(this.stored.get(a) as Shape, this.stored.get(b) as Shape);
    for (const siblings of this.children.values()) siblings.sort(byOrder);

    this.frames = new Map();
    const walk = (parent: ShapeId | null, frames: readonly ShapeId[]) => {
      for (const id of this.childrenOf(parent)) {
        if (frames.length > 0) this.frames.set(id, frames);
        walk(id, this.stored.get(id)?.type === "frame" ? [...frames, id] : frames);
      }
    };
    walk(null, []);
  }

  /** Refits the groups around shapes that moved, innermost first. */
  private fitGroups(moved: Iterable<ShapeId>): void {
    const groups = new Map<ShapeId, number>();
    for (const id of moved) {
      const ancestors = this.ancestorsOf(id);
      if (this.stored.get(id)?.type === "group") ancestors.unshift(id);
      ancestors.forEach((ancestor, i) => {
        if (this.stored.get(ancestor)?.type !== "group") return;
        // Deeper groups are fitted first: their depth from the top is larger.
        const depth = ancestors.length - i;
        groups.set(ancestor, Math.max(groups.get(ancestor) ?? 0, depth));
      });
    }
    for (const [id] of [...groups].sort((a, b) => b[1] - a[1])) this.fitGroup(id);
  }

  /** A group's drawn box: around everything in it, upright. */
  private fitGroup(id: ShapeId): void {
    const group = this.stored.get(id);
    if (!group) return;
    const boxes: Box[] = [];
    for (const child of this.childrenOf(id)) {
      const shape = this.shapes.get(child);
      // An empty group inside this one has no box.
      if (shape && !(shape.type === "group" && this.childrenOf(child).length === 0))
        boxes.push(shapeBounds(shape));
    }
    const box = unionBoxes(boxes);
    this.draw(
      box
        ? { ...group, x: box.minX, y: box.minY, w: box.maxX - box.minX, h: box.maxY - box.minY }
        : { ...group, w: 0, h: 0 },
    );
  }

  private link(shape: Shape): void {
    if (shape.type !== "arrow") return;
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
    for (const target of [shape.from, shape.to]) {
      if (target === null) continue;
      const arrows = this.attached.get(target);
      arrows?.delete(shape.id);
      if (arrows?.size === 0) this.attached.delete(target);
    }
  }
}

/** True when `p` is inside `shape`'s box, edges included. */
function inside(shape: Shape, p: Point): boolean {
  const local = toShapeFrame(shape, p);
  return Math.abs(local.x) <= shape.w / 2 && Math.abs(local.y) <= shape.h / 2;
}
