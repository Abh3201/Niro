import {
  DEFAULT_COLOR,
  type DocStore,
  holdsText,
  isLinear,
  type LineRoute,
  newShapeId,
  type Shape,
  type ShapeId,
  type ShapePatch,
  type ShapeType,
  type Tx,
} from "@niro/doc";
import { asDrawn, canAttachTo, detachUnless } from "./arrows";
import type { Camera } from "./camera";
import { type PenPoint, strokeShape } from "./freehand";
import {
  type Box,
  boxContainsBox,
  boxFromPoints,
  distance,
  type Point,
  unionBoxes,
} from "./geometry";
import type { Scene } from "./scene";
import {
  frameCenter,
  handleAt,
  handleWorldPoint,
  insideFrame,
  resizeCursor,
  type SelectionFrame,
  selectionFrame,
} from "./selection";
import { shapeBounds } from "./shapes";
import { type Guide, SNAP_PX, snapBox } from "./snapping";
import {
  adoptInto,
  hasLocked,
  isLocked,
  movers,
  noteAt,
  outermost,
  placeNew,
  placeOnNote,
  releaseOutside,
  reparentOnMove,
  selectableUnit,
  settleNew,
  stepInto,
  withDescendants,
} from "./structure";
import { DEFAULT_TEXT_WIDTH, TEXT_FONT_SIZE, textHeight, withHeight } from "./text";
import {
  HANDLE_DIRECTIONS,
  type Handle,
  moveLineEnd,
  resizeBox,
  rotateAroundPivot,
  scaleAround,
  snapAngle,
  snapAround,
  translate,
} from "./transform";

export type ToolName =
  | "select"
  | "hand"
  | "rectangle"
  | "ellipse"
  | "sticky"
  | "line"
  | "arrow"
  | "text"
  | "pen"
  | "frame"
  | "laser";

/** The tools that drag out a shape of their own type. */
type ShapeTool = "rectangle" | "ellipse" | "sticky" | "line" | "arrow" | "frame";

export interface ToolPointer {
  readonly pointerId: number;
  readonly pointerType: string;
  /** CSS pixels relative to the board's top-left. */
  readonly screen: Point;
  readonly world: Point;
  readonly shiftKey: boolean;
  /** Alt (Option) is held: a move doesn't snap. */
  readonly altKey?: boolean;
  /** Pen pressure from 0 to 1; 0.5 for anything that can't sense it. */
  readonly pressure: number;
  /**
   * Where the pointer was in between, for a move: browsers merge the
   * movements of a fast pointer into one event per frame, and a pen
   * stroke wants them all. Oldest first, ending with this one.
   */
  readonly samples?: readonly PenPoint[];
}

/** What gestures need from the engine. */
export interface EditorHost {
  readonly doc: DocStore;
  readonly scene: Scene;
  /** Edits the document in board coordinates (see `board-tx.ts`). */
  transact(fn: (tx: Tx) => void): void;
  camera(): Camera;
  tool(): ToolName;
  setTool(tool: ToolName): void;
  selection(): readonly ShapeId[];
  setSelection(ids: readonly ShapeId[]): void;
  /** Runs `write` before the next frame is drawn; a newer call replaces an older one. */
  scheduleWrite(write: () => void): void;
  /** Runs the pending write now. */
  flushWrite(): void;
  /** The marquee, hover or cursor changed: the overlay needs a redraw. */
  overlayChanged(): void;
  /** Starts editing the text of a shape in the document. */
  startEditing(id: ShapeId): void;
  /** Starts editing a new text shape, which goes into the document once something is typed. */
  startDraft(shape: Shape): void;
  /** The height a text shape needs for its text. */
  fittedHeight(shape: Shape): number;
  /** The laser pointer is at `p`, or (null) was let go. */
  laser?(p: Point | null): void;
  /** How arrows drawn from now on are routed. */
  arrowRoute?(): LineRoute;
}

/** Hit tolerance around shapes and lines, in CSS pixels. */
const HIT_TOLERANCE = 4;
/** How far a pointer must travel before a press becomes a drag, in CSS pixels. */
const DRAG_THRESHOLD = { mouse: 3, touch: 8 };

const DEFAULT_SIZE: Record<
  "rectangle" | "ellipse" | "sticky" | "text" | "frame",
  { w: number; h: number }
> = {
  rectangle: { w: 160, h: 120 },
  ellipse: { w: 140, h: 140 },
  sticky: { w: 200, h: 200 },
  text: { w: DEFAULT_TEXT_WIDTH, h: textHeight(1, TEXT_FONT_SIZE) },
  frame: { w: 640, h: 400 },
};
/** Narrowest text shape a drag with the text tool makes, in world units. */
const MIN_TEXT_WIDTH = 40;
const DEFAULT_LINE_LENGTH = 160;
/** How far from the selection, in CSS pixels, shapes are looked at for snapping. */
const SNAP_REACH_PX = 1200;

type Gesture =
  | { kind: "idle" }
  /** Pressed, not dragged yet. `onDrag` decides what a drag turns into. */
  | {
      kind: "pending";
      start: ToolPointer;
      onDrag: "move" | "marquee" | "none";
      /** Applied if the pointer comes up without dragging. */
      onClick?: () => void;
    }
  /**
   * Moving the selection. `before` is what the move writes, as drawn when it
   * started; `moving` is everything that goes along, including what's in
   * frames; `units` are the selected shapes, which can change frames.
   */
  | {
      kind: "move";
      start: ToolPointer;
      before: Map<ShapeId, Shape>;
      moving: ReadonlySet<ShapeId>;
      units: readonly Shape[];
    }
  | { kind: "marquee"; start: ToolPointer; current: Point; base: readonly ShapeId[] }
  | {
      kind: "resize";
      start: ToolPointer;
      handle: Handle;
      frame: SelectionFrame;
      before: Map<ShapeId, Shape>;
    }
  | { kind: "rotate"; start: ToolPointer; pivot: Point; before: Map<ShapeId, Shape> }
  /** Dragging a line's or arrow's end; `target` is the shape an arrow's end would attach to. */
  | {
      kind: "line-end";
      start: ToolPointer;
      end: "start" | "end";
      before: Shape;
      target: ShapeId | null;
    }
  /** Dragging out a shape. An arrow starts attached to `from` and ends attached to `target`. */
  | {
      kind: "create";
      start: ToolPointer;
      type: ShapeTool;
      id: ShapeId | null;
      from: ShapeId | null;
      target: ShapeId | null;
    }
  /** The laser pointer: shown to everyone, never stored. */
  | { kind: "laser" }
  /** A pen stroke, drawn in the overlay until it's finished. */
  | { kind: "draw"; points: PenPoint[]; host: ShapeId | null }
  /** The text tool: a click places a text shape, a drag sets its width. `onto` is a text shape clicked to edit it. */
  | {
      kind: "text";
      start: ToolPointer;
      current: ToolPointer;
      dragged: boolean;
      onto: ShapeId | null;
    };

/**
 * Pointer gestures for the select and shape tools: select, marquee, move,
 * resize, rotate, drag out new shapes. Navigation (pan, zoom, pinch) is the
 * input controller's job; it hands a pointer to this class only when the
 * active tool wants it.
 */
export class Interaction {
  private gesture: Gesture = { kind: "idle" };
  /** Ends the undo step the current gesture holds open, if it holds one. */
  private releaseStep: (() => void) | null = null;
  private hoveredId: ShapeId | null = null;
  private hoverCursor = "";
  /** The sticky note a pen stroke started now would belong to. */
  private inkHover: ShapeId | null = null;
  /** Guide lines for the snap the current move is making. */
  private snapGuides: readonly Guide[] = [];

  constructor(private readonly host: EditorHost) {}

  /** The marquee rectangle in world coordinates while one is being dragged. */
  marquee(): Box | null {
    const g = this.gesture;
    if (g.kind === "marquee") return boxFromPoints([g.start.world, g.current]);
    if (g.kind === "text" && g.dragged) return boxFromPoints([g.start.world, g.current.world]);
    return null;
  }

  /** The guides to draw while a move is snapped to other shapes, in world coordinates. */
  guides(): readonly Guide[] {
    return this.gesture.kind === "move" ? this.snapGuides : [];
  }

  hovered(): ShapeId | null {
    return this.gesture.kind === "idle" ? this.hoveredId : null;
  }

  /** The pen stroke being drawn, in world coordinates. */
  drawing(): readonly PenPoint[] | null {
    return this.gesture.kind === "draw" ? this.gesture.points : null;
  }

  /**
   * The sticky note the pen's ink goes onto: the one a stroke in progress
   * started on, or the one under the pen. Holding Alt as a stroke starts
   * puts it on the board instead.
   */
  inkTarget(): ShapeId | null {
    const g = this.gesture;
    if (g.kind === "draw") return g.host;
    return g.kind === "idle" && this.host.tool() === "pen" ? this.inkHover : null;
  }

  /** The shape the arrow end being dragged would attach to. */
  attachTarget(): ShapeId | null {
    const g = this.gesture;
    return g.kind === "create" || g.kind === "line-end" ? g.target : null;
  }

  /** True while a gesture that writes to the document is running. */
  busy(): boolean {
    return this.gesture.kind !== "idle" && this.gesture.kind !== "pending";
  }

  cursor(): string {
    const tool = this.host.tool();
    if (tool === "text") return "text";
    if (tool !== "select" && tool !== "hand") return "crosshair";
    const g = this.gesture;
    if (g.kind === "move") return "move";
    if (g.kind === "rotate") return "grabbing";
    if (g.kind === "resize")
      return resizeCursor(g.handle, g.frame.kind === "box" ? g.frame.shape.rotation : 0);
    return this.hoverCursor;
  }

  /** What the selection's handles act on; none for a selection with something locked in it. */
  frame(): SelectionFrame | null {
    const { scene } = this.host;
    const ids = this.host.selection();
    if (hasLocked(scene, ids)) return null;
    const shapes = ids.map((id) => scene.get(id)).filter((s): s is Shape => s !== undefined);
    const rotatable = !withDescendants(scene, ids).some((id) => scene.get(id)?.type === "frame");
    return selectionFrame(shapes, rotatable);
  }

  /**
   * Makes everything from now until `endStep` one undo step, so a gesture
   * the user pauses in the middle of still undoes in one go.
   */
  private holdStep(): void {
    this.endStep();
    this.releaseStep = this.host.doc.holdStep();
  }

  private endStep(): void {
    this.releaseStep?.();
    this.releaseStep = null;
  }

  /** Returns false when the tool doesn't want this pointer (the input controller then pans). */
  pointerDown(p: ToolPointer): boolean {
    const tool = this.host.tool();
    if (tool === "hand") return false;
    if (tool === "text") {
      const hit = this.host.scene.hit(p.world, HIT_TOLERANCE / this.host.camera().zoom);
      const onto = hit?.type === "text" ? hit.id : null;
      this.gesture = { kind: "text", start: p, current: p, dragged: false, onto };
      return true;
    }
    if (tool === "laser") {
      this.gesture = { kind: "laser" };
      this.host.laser?.(p.world);
      return true;
    }
    if (tool === "pen") {
      // Each stroke is its own undo step, however quickly the next follows.
      this.host.doc.checkpoint();
      const host = p.altKey ? null : noteAt(this.host.scene, p.world);
      this.gesture = { kind: "draw", points: [penPoint(p)], host };
      this.host.overlayChanged();
      return true;
    }
    if (tool !== "select") {
      this.holdStep();
      const from = tool === "arrow" ? this.attachableAt(p, []) : null;
      this.gesture = { kind: "create", start: p, type: tool, id: null, from, target: null };
      return true;
    }
    return this.selectDown(p);
  }

  pointerMove(p: ToolPointer): void {
    const g = this.gesture;
    if (g.kind === "text") {
      g.current = p;
      g.dragged ||= distance(p.screen, g.start.screen) >= dragThreshold(p);
      if (g.dragged) this.host.overlayChanged();
      return;
    }
    if (g.kind === "laser") {
      this.host.laser?.(p.world);
      return;
    }
    if (g.kind === "draw") {
      g.points.push(...(p.samples ?? [penPoint(p)]));
      this.host.overlayChanged();
      return;
    }
    if (g.kind === "pending") {
      if (distance(p.screen, g.start.screen) < dragThreshold(p)) return;
      if (g.onDrag === "move") this.beginMove(g.start);
      else if (g.onDrag === "marquee")
        this.gesture = {
          kind: "marquee",
          start: g.start,
          current: g.start.world,
          base: this.host.selection(),
        };
      else return;
    }
    this.drag(p);
  }

  pointerUp(p: ToolPointer): void {
    const g = this.gesture;
    // Idle first: finishing can switch tools, and switching tools cancels
    // whatever gesture is still running.
    this.gesture = { kind: "idle" };
    this.snapGuides = [];
    if (g.kind === "laser") this.host.laser?.(null);
    if (g.kind === "pending") g.onClick?.();
    if (g.kind === "resize") this.finishResize(g);
    if (g.kind === "create") this.finishCreate(g, p);
    if (g.kind === "text") this.finishText(g, p);
    if (g.kind === "draw") this.finishDraw(g);
    this.host.flushWrite();
    this.endStep();
    // Handles are hidden during a drag: show them again, even if the last
    // write was already drawn.
    if (g.kind !== "pending") this.host.overlayChanged();
    this.hover(p);
  }

  /** Abandons the current gesture, putting back anything it changed. Returns false if there was none. */
  cancel(): boolean {
    const g = this.gesture;
    if (g.kind === "idle") return false;
    this.gesture = { kind: "idle" };
    this.snapGuides = [];
    if (g.kind === "move" || g.kind === "resize" || g.kind === "rotate") this.restore(g.before);
    if (g.kind === "line-end") this.restore(new Map([[g.before.id, g.before]]));
    if (g.kind === "create" && g.id !== null) {
      const id = g.id;
      this.host.scheduleWrite(() => this.host.transact((tx) => tx.remove(id)));
    }
    if (g.kind === "marquee") this.host.setSelection(g.base);
    if (g.kind === "laser") this.host.laser?.(null);
    // A cancelled pen stroke was only ever in the overlay.
    this.host.flushWrite();
    this.endStep();
    this.host.overlayChanged();
    return true;
  }

  /**
   * A double click: steps into the group under the pointer, edits the text
   * of the shape there, or starts a text shape on empty space.
   */
  doubleClick(p: ToolPointer): void {
    const { host } = this;
    if (host.tool() !== "select" || this.gesture.kind !== "idle") return;
    const hit = host.scene.hit(p.world, HIT_TOLERANCE / host.camera().zoom);
    const unit = hit && selectableUnit(host.scene, hit.id, host.selection());
    if (hit && unit !== hit.id) {
      // Stepping into a group only changes the selection, so it works on a read-only board.
      const inner = stepInto(host.scene, unit as ShapeId, hit.id);
      if (inner) host.setSelection([inner]);
      return;
    }
    if (host.doc.readOnly) return;
    if (!hit) host.startDraft(this.newShape(newShapeId(), "text", textAt(p.world)));
    else if (holdsText(hit.type)) host.startEditing(hit.id);
  }

  /** Pointer moving with no button down: updates the hover outline and cursor. */
  hover(p: ToolPointer): void {
    if (this.gesture.kind !== "idle") return;
    let hovered: ShapeId | null = null;
    let cursor = "";
    if (this.host.tool() === "pen") {
      const note = p.altKey ? null : noteAt(this.host.scene, p.world);
      if (note !== this.inkHover) {
        this.inkHover = note;
        this.host.overlayChanged();
      }
    }
    if (this.host.tool() === "select") {
      const frame = this.frame();
      const handle =
        frame && !this.host.doc.readOnly ? handleAt(frame, this.host.camera(), p.screen) : null;
      if (handle?.kind === "resize")
        cursor = resizeCursor(handle.handle, frame?.kind === "box" ? frame.shape.rotation : 0);
      else if (handle?.kind === "rotate") cursor = "grab";
      else if (handle?.kind === "line-end") cursor = "crosshair";
      else hovered = this.unitAt(p);
    }
    if (hovered !== this.hoveredId || cursor !== this.hoverCursor) {
      this.hoveredId = hovered;
      this.hoverCursor = cursor;
      this.host.overlayChanged();
    }
  }

  /** What a click at `p` would select: the shape there, or the group it's in. */
  private unitAt(p: ToolPointer): ShapeId | null {
    const { scene } = this.host;
    const hit = scene.hit(p.world, HIT_TOLERANCE / this.host.camera().zoom);
    return hit ? selectableUnit(scene, hit.id, this.host.selection()) : null;
  }

  private selectDown(p: ToolPointer): boolean {
    const { host } = this;
    const readOnly = host.doc.readOnly;
    const frame = this.frame();

    const handle = frame && !readOnly ? handleAt(frame, host.camera(), p.screen) : null;
    if (frame && handle) {
      this.holdStep();
      // Resizing a frame leaves what's in it where it is (it's written too,
      // since it's stored from the frame's corner, which may move); every
      // other change carries the contents along.
      const before =
        frame.kind === "box"
          ? this.snapshot([
              frame.shape.id,
              ...movers(host.scene, host.scene.childrenOf(frame.shape.id)),
            ])
          : this.snapshot(withDescendants(host.scene, host.selection()));
      if (handle.kind === "rotate")
        this.gesture = { kind: "rotate", start: p, pivot: frameCenter(frame), before };
      else if (handle.kind === "resize")
        this.gesture = { kind: "resize", start: p, handle: handle.handle, frame, before };
      else if (frame.kind === "line")
        this.gesture = {
          kind: "line-end",
          start: p,
          end: handle.end,
          before: frame.shape,
          target: handle.end === "start" ? frame.shape.from : frame.shape.to,
        };
      return true;
    }

    const selection = host.selection();
    const hit = this.unitAt(p);
    // Locked shapes can be picked (to unlock them) but not dragged, and a
    // drag that starts on one is a marquee, as though it were the board.
    const lockedHit = hit !== null && hasLocked(host.scene, [hit]);
    const onDrag = readOnly || lockedHit || hasLocked(host.scene, selection) ? "none" : "move";
    if (hit && lockedHit && !p.shiftKey) {
      host.setSelection([]);
      this.gesture = {
        kind: "pending",
        start: p,
        onDrag: readOnly || p.pointerType === "touch" ? "none" : "marquee",
        onClick: () => host.setSelection([hit]),
      };
      return true;
    }
    if (hit) {
      const selected = selection.includes(hit);
      if (p.shiftKey) {
        if (!selected) host.setSelection(outermost(host.scene, [...selection, hit]));
        this.gesture = {
          kind: "pending",
          start: p,
          onDrag,
          // Shift-click on a selected shape deselects it, unless it was dragged.
          ...(selected && {
            onClick: () => host.setSelection(host.selection().filter((id) => id !== hit)),
          }),
        };
      } else {
        if (!selected) host.setSelection([hit]);
        this.gesture = {
          kind: "pending",
          start: p,
          onDrag,
          // Clicking one shape of a multi-selection picks it alone, unless it was dragged.
          ...(selected && selection.length > 1 && { onClick: () => host.setSelection([hit]) }),
        };
      }
      return true;
    }

    // Empty space inside the selection's frame drags the whole selection:
    // between the shapes of several, or a group's, or inside a frame.
    if (
      frame &&
      (frame.kind === "group" || (frame.kind === "box" && frame.shape.type === "frame")) &&
      insideFrame(frame, host.camera(), p.screen)
    ) {
      this.gesture = { kind: "pending", start: p, onDrag, onClick: () => host.setSelection([]) };
      return true;
    }

    if (!p.shiftKey) host.setSelection([]);
    // On a touch screen, one finger on empty space pans instead of drawing a marquee.
    if (p.pointerType === "touch") return false;
    this.gesture = { kind: "pending", start: p, onDrag: "marquee" };
    return true;
  }

  private beginMove(start: ToolPointer): void {
    const { host } = this;
    this.holdStep();
    const units = outermost(host.scene, host.selection());
    // Selected groups are in `before` so a cancelled move puts them back in their frames.
    this.gesture = {
      kind: "move",
      start,
      before: this.snapshot([...units, ...movers(host.scene, units)]),
      moving: new Set(withDescendants(host.scene, units)),
      units: [...this.snapshot(units).values()],
    };
  }

  private drag(p: ToolPointer): void {
    const { host } = this;
    const g = this.gesture;
    switch (g.kind) {
      case "move": {
        let dx = p.world.x - g.start.world.x;
        let dy = p.world.y - g.start.world.y;
        const free = { x: true, y: true };
        if (p.shiftKey) {
          // Lock to the axis with the larger movement.
          if (Math.abs(dx) > Math.abs(dy)) {
            dy = 0;
            free.y = false;
          } else {
            dx = 0;
            free.x = false;
          }
        }
        // Edges and centers line up with other shapes' (Alt turns it off).
        const snap = p.altKey ? null : this.snap(g, dx, dy, free);
        this.snapGuides = snap?.guides ?? [];
        dx += snap?.dx ?? 0;
        dy += snap?.dy ?? 0;
        // Shapes dragged into or out of a frame join or leave it as they go.
        this.write(
          g.before,
          (shape) => translate(shape, dx, dy),
          g.moving,
          () => reparentOnMove(host.scene, g.units, g.moving, dx, dy),
        );
        break;
      }
      case "marquee": {
        g.current = p.world;
        const box = boxFromPoints([g.start.world, g.current]);
        const ids = new Set(g.base);
        for (const shape of host.scene.inBox(box)) {
          // Groups are found through what's in them; locked shapes are left alone.
          if (shape.type === "group" || isLocked(host.scene, shape.id)) continue;
          const unit = selectableUnit(host.scene, shape.id, g.base);
          const unitShape = host.scene.get(unit);
          // A frame is selected only when the marquee takes it in whole, so
          // one started inside a frame selects what's in it.
          if (unitShape?.type === "frame" && !boxContainsBox(box, shapeBounds(unitShape))) continue;
          ids.add(unit);
        }
        host.setSelection(outermost(host.scene, ids));
        host.overlayChanged();
        break;
      }
      case "resize": {
        const { frame, handle } = g;
        if (frame.kind === "box") {
          const shape = g.before.get(frame.shape.id);
          if (shape)
            this.write(g.before, (s) =>
              s.id === shape.id
                ? // An image keeps its proportions unless Shift is held; other shapes, only while it is.
                  resizeBox(shape, handle, p.world, p.shiftKey !== (shape.type === "image"))
                : { x: s.x, y: s.y },
            );
        } else {
          // Several shapes scale uniformly from the opposite corner.
          const opposite = (Object.keys(HANDLE_DIRECTIONS) as Handle[]).find((h) => {
            const d = HANDLE_DIRECTIONS[h];
            const o = HANDLE_DIRECTIONS[handle];
            return d.x === -o.x && d.y === -o.y;
          }) as Handle;
          const anchor = handleWorldPoint(frame, opposite);
          const corner = handleWorldPoint(frame, handle);
          const diagonal = { x: corner.x - anchor.x, y: corner.y - anchor.y };
          const lengthSq = diagonal.x ** 2 + diagonal.y ** 2;
          const s =
            lengthSq === 0
              ? 1
              : ((p.world.x - anchor.x) * diagonal.x + (p.world.y - anchor.y) * diagonal.y) /
                lengthSq;
          this.write(g.before, (shape) => scaleAround(shape, anchor, Math.max(0.01, s)), g.before);
        }
        break;
      }
      case "rotate": {
        const angle = (q: Point) => Math.atan2(q.y - g.pivot.y, q.x - g.pivot.x);
        let delta = angle(p.world) - angle(g.start.world);
        if (p.shiftKey) {
          // Snap the resulting angle of a single shape, or the turn of a group.
          const single = g.before.size === 1 ? [...g.before.values()][0] : undefined;
          const base = single && !isLinear(single.type) ? single.rotation : 0;
          delta = snapAngle(base + delta) - base;
        }
        this.write(g.before, (shape) => rotateAroundPivot(shape, g.pivot, delta), g.before);
        break;
      }
      case "line-end": {
        const shape = g.before;
        let attach: ShapePatch = {};
        if (shape.type === "arrow") {
          // An end attaches to whatever box it's dropped on, other than the
          // shape the other end is attached to.
          const other = g.end === "start" ? shape.to : shape.from;
          g.target = this.attachableAt(p, [shape.id, other]);
          attach = g.end === "start" ? { from: g.target } : { to: g.target };
          host.overlayChanged();
        }
        this.write(new Map([[shape.id, shape]]), () => ({
          ...moveLineEnd(shape, g.end, p.world, p.shiftKey),
          ...attach,
        }));
        break;
      }
      case "create": {
        let patch = createdGeometry(g.type, g.start.world, p.world, p.shiftKey);
        if (g.type === "arrow") {
          g.target = this.attachableAt(p, [g.from, g.id]);
          patch = { ...patch, from: g.from, to: g.target };
          host.overlayChanged();
        }
        if (g.id === null) {
          const id = newShapeId();
          g.id = id;
          const shape = this.newShape(id, g.type, patch);
          host.scheduleWrite(() => host.transact((tx) => tx.add(shape)));
          host.flushWrite();
          host.setSelection([id]);
        } else {
          const id = g.id;
          host.scheduleWrite(() => host.transact((tx) => tx.update(id, patch)));
        }
        break;
      }
    }
  }

  /** How far the move of `g` by `(dx, dy)` should be nudged to line up with other shapes, and the guides for it. */
  private snap(
    g: Extract<Gesture, { kind: "move" }>,
    dx: number,
    dy: number,
    free: { x: boolean; y: boolean },
  ) {
    const { scene } = this.host;
    const moving = unionBoxes(
      g.units.map((unit) => shapeBounds({ ...unit, ...translate(unit, dx, dy) })),
    );
    if (!moving) return null;
    const zoom = this.host.camera().zoom;
    // Shapes about a screenful away: farther ones are off screen, and a
    // guide to something you can't see is no help.
    const reach = SNAP_REACH_PX / zoom;
    const area = {
      minX: moving.minX - reach,
      minY: moving.minY - reach,
      maxX: moving.maxX + reach,
      maxY: moving.maxY + reach,
    };
    const targets = scene
      .inBox(area)
      .filter((s) => s.type !== "group" && !isLinear(s.type) && !g.moving.has(s.id))
      .map(shapeBounds);
    return snapBox(moving, targets, SNAP_PX / zoom, free);
  }

  /** A resized frame takes in the shapes now inside it and lets go of those outside. */
  private finishResize(g: Extract<Gesture, { kind: "resize" }>): void {
    const { host } = this;
    if (g.frame.kind !== "box" || g.frame.shape.type !== "frame") return;
    const id = g.frame.shape.id;
    host.flushWrite();
    host.transact((tx) => {
      releaseOutside(host.scene, tx, id);
      adoptInto(host.scene, tx, id);
    });
  }

  private finishCreate(g: Extract<Gesture, { kind: "create" }>, p: ToolPointer): void {
    const { host } = this;
    let id = g.id;
    if (id === null) {
      // A click without a drag drops a default-size shape centered on the pointer.
      id = newShapeId();
      const shape = this.newShape(id, g.type, defaultGeometry(g.type, p.world));
      host.scheduleWrite(() => host.transact((tx) => tx.add(shape)));
    }
    host.flushWrite();
    // Part of the same undo step as drawing it: where it ended up decides
    // which frame it's in, and a new frame takes in what it was drawn around.
    const created = id;
    host.transact((tx) => settleNew(host.scene, tx, created));
    if (g.type === "frame") host.transact((tx) => adoptInto(host.scene, tx, created));
    host.setSelection([id]);
    host.setTool("select");
    // Sticky notes are for writing on.
    if (g.type === "sticky") host.startEditing(id);
  }

  /** Adds the finished stroke. The pen stays in hand for the next one. */
  private finishDraw(g: Extract<Gesture, { kind: "draw" }>): void {
    const { host } = this;
    if (g.points.length === 0) return;
    const stroke = this.newShape(newShapeId(), "freehand", strokeShape(g.points), g.host);
    host.scheduleWrite(() => host.transact((tx) => tx.add(stroke)));
    host.overlayChanged();
  }

  /** The topmost shape under `p` an arrow can attach to, other than those in `exclude`. */
  private attachableAt(p: ToolPointer, exclude: ReadonlyArray<ShapeId | null>): ShapeId | null {
    const tolerance = HIT_TOLERANCE / this.host.camera().zoom;
    const shape = this.host.scene.hit(
      p.world,
      tolerance,
      (s) => canAttachTo(s) && !exclude.includes(s.id),
    );
    return shape?.id ?? null;
  }

  private finishText(g: Extract<Gesture, { kind: "text" }>, p: ToolPointer): void {
    const { host } = this;
    host.setTool("select");
    if (g.onto && !g.dragged) {
      host.startEditing(g.onto);
      return;
    }
    let geometry = textAt(g.start.world);
    if (g.dragged) {
      // A drag sets where the text starts and how wide it wraps.
      const from = g.start.world;
      const width = Math.max(MIN_TEXT_WIDTH, Math.abs(p.world.x - from.x));
      geometry = {
        ...geometry,
        x: Math.min(from.x, p.world.x),
        y: Math.min(from.y, p.world.y),
        w: width,
      };
    }
    host.startDraft(this.newShape(newShapeId(), "text", geometry));
  }

  /** A new shape, on top, in the frame it's drawn in, or for ink, on the note it's drawn on. */
  private newShape(
    id: ShapeId,
    type: ShapeType,
    geometry: ShapePatch,
    note: ShapeId | null = null,
  ): Shape {
    const shape: Shape = {
      id,
      type,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rotation: 0,
      parentId: null,
      index: "a0",
      color: DEFAULT_COLOR[type],
      text: "",
      points: [],
      from: null,
      to: null,
      ...(type === "arrow" && this.host.arrowRoute?.() === "elbow" && { route: "elbow" as const }),
      ...geometry,
    };
    return {
      ...shape,
      ...(type === "freehand"
        ? placeOnNote(this.host.scene, shape, note)
        : placeNew(this.host.scene, shape)),
    };
  }

  private snapshot(ids: readonly ShapeId[]): Map<ShapeId, Shape> {
    const result = new Map<ShapeId, Shape>();
    for (const id of ids) {
      const shape = this.host.scene.get(id);
      if (shape) result.set(id, shape);
    }
    return result;
  }

  /**
   * Schedules one transaction applying `patch` to every shape in `before`,
   * which are shapes as drawn, and then the patches `extra` returns when
   * the write runs. A text shape's height follows its text, whatever its
   * new width. With `along`, the shapes moving together, an arrow lets go
   * of shapes that aren't. Groups are skipped: their boxes follow what's in
   * them.
   */
  private write(
    before: Map<ShapeId, Shape>,
    patch: (shape: Shape) => ShapePatch,
    along: { has(id: ShapeId): boolean } | null = null,
    extra?: () => Map<ShapeId, ShapePatch>,
  ): void {
    const { host } = this;
    host.scheduleWrite(() => {
      const more = extra?.();
      host.transact((tx) => {
        for (const shape of before.values()) {
          if (shape.type === "group") continue;
          let change = { ...asDrawn(shape), ...patch(shape) };
          if (shape.type === "text") {
            const next = { ...shape, ...change };
            change = { ...change, ...withHeight(next, host.fittedHeight(next)) };
          }
          if (along) change = { ...change, ...detachUnless(shape, (id) => along.has(id)) };
          tx.update(shape.id, change);
        }
        for (const [id, change] of more ?? []) tx.update(id, change);
      });
    });
  }

  /** Puts every shape in `before` back as it was, including which frame or group it was in. */
  private restore(before: Map<ShapeId, Shape>): void {
    const groups = new Map<ShapeId, ShapePatch>();
    for (const shape of before.values())
      if (shape.type === "group")
        groups.set(shape.id, { parentId: shape.parentId, index: shape.index });
    this.write(
      before,
      (shape) => {
        const { id: _id, type: _type, text: _text, points: _points, ...fields } = shape;
        return fields;
      },
      null,
      () => groups,
    );
  }
}

/** Geometry of a shape dragged out from `from` to `to`. With `constrain`, boxes are square and lines snap to 15°. */
export function createdGeometry(
  type: ShapeType,
  from: Point,
  to: Point,
  constrain: boolean,
): ShapePatch {
  if (isLinear(type)) {
    const end = constrain ? snapAround(from, to) : to;
    return { x: from.x, y: from.y, w: end.x - from.x, h: end.y - from.y };
  }
  let w = to.x - from.x;
  let h = to.y - from.y;
  if (constrain || type === "sticky") {
    // Sticky notes are always square, like paper ones.
    const size = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * size;
    h = Math.sign(h || 1) * size;
  }
  return {
    x: Math.min(from.x, from.x + w),
    y: Math.min(from.y, from.y + h),
    w: Math.max(1, Math.abs(w)),
    h: Math.max(1, Math.abs(h)),
  };
}

const dragThreshold = (p: ToolPointer) =>
  p.pointerType === "touch" ? DRAG_THRESHOLD.touch : DRAG_THRESHOLD.mouse;

/** A one-line text shape starting at `at`, its first line centered on it. */
function textAt(at: Point): ShapePatch {
  const { w, h } = DEFAULT_SIZE.text;
  return { x: at.x, y: at.y - h / 2, w, h };
}

const penPoint = (p: ToolPointer): PenPoint => ({ ...p.world, pressure: p.pressure });

function defaultGeometry(type: ShapeTool, center: Point): ShapePatch {
  if (type === "line" || type === "arrow") {
    return { x: center.x - DEFAULT_LINE_LENGTH / 2, y: center.y, w: DEFAULT_LINE_LENGTH, h: 0 };
  }
  const { w, h } = DEFAULT_SIZE[type];
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}
