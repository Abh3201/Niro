import {
  DEFAULT_COLOR,
  type DocStore,
  holdsText,
  indexAbove,
  newShapeId,
  type Shape,
  type ShapeId,
  type ShapePatch,
  type ShapeType,
} from "@niro/doc";
import type { Camera } from "./camera";
import { type Box, boxFromPoints, distance, type Point } from "./geometry";
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

export type ToolName = "select" | "hand" | "rectangle" | "ellipse" | "sticky" | "line" | "text";

export interface ToolPointer {
  readonly pointerId: number;
  readonly pointerType: string;
  /** CSS pixels relative to the board's top-left. */
  readonly screen: Point;
  readonly world: Point;
  readonly shiftKey: boolean;
}

/** What gestures need from the engine. */
export interface EditorHost {
  readonly doc: DocStore;
  readonly scene: Scene;
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
}

/** Hit tolerance around shapes and lines, in CSS pixels. */
const HIT_TOLERANCE = 4;
/** How far a pointer must travel before a press becomes a drag, in CSS pixels. */
const DRAG_THRESHOLD = { mouse: 3, touch: 8 };

const DEFAULT_SIZE: Record<Exclude<ShapeType, "line">, { w: number; h: number }> = {
  rectangle: { w: 160, h: 120 },
  ellipse: { w: 140, h: 140 },
  sticky: { w: 200, h: 200 },
  text: { w: DEFAULT_TEXT_WIDTH, h: textHeight(1, TEXT_FONT_SIZE) },
};
/** Narrowest text shape a drag with the text tool makes, in world units. */
const MIN_TEXT_WIDTH = 40;
const DEFAULT_LINE_LENGTH = 160;

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
  | { kind: "move"; start: ToolPointer; before: Map<ShapeId, Shape> }
  | { kind: "marquee"; start: ToolPointer; current: Point; base: readonly ShapeId[] }
  | {
      kind: "resize";
      start: ToolPointer;
      handle: Handle;
      frame: SelectionFrame;
      before: Map<ShapeId, Shape>;
    }
  | { kind: "rotate"; start: ToolPointer; pivot: Point; before: Map<ShapeId, Shape> }
  | { kind: "line-end"; start: ToolPointer; end: "start" | "end"; before: Shape }
  | { kind: "create"; start: ToolPointer; type: ShapeType; id: ShapeId | null }
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
  private hoveredId: ShapeId | null = null;
  private hoverCursor = "";

  constructor(private readonly host: EditorHost) {}

  /** The marquee rectangle in world coordinates while one is being dragged. */
  marquee(): Box | null {
    const g = this.gesture;
    if (g.kind === "marquee") return boxFromPoints([g.start.world, g.current]);
    if (g.kind === "text" && g.dragged) return boxFromPoints([g.start.world, g.current.world]);
    return null;
  }

  hovered(): ShapeId | null {
    return this.gesture.kind === "idle" ? this.hoveredId : null;
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
    if (tool !== "select") {
      this.host.doc.checkpoint();
      this.gesture = { kind: "create", start: p, type: tool, id: null };
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
    if (g.kind === "pending") g.onClick?.();
    if (g.kind === "create") this.finishCreate(g, p);
    if (g.kind === "text") this.finishText(g, p);
    this.host.flushWrite();
    this.hover(p);
  }

  /** Abandons the current gesture, putting back anything it changed. Returns false if there was none. */
  cancel(): boolean {
    const g = this.gesture;
    if (g.kind === "idle") return false;
    this.gesture = { kind: "idle" };
    if (g.kind === "move" || g.kind === "resize" || g.kind === "rotate") this.restore(g.before);
    if (g.kind === "line-end") this.restore(new Map([[g.before.id, g.before]]));
    if (g.kind === "create" && g.id !== null) {
      const id = g.id;
      this.host.scheduleWrite(() => this.host.doc.transact((tx) => tx.remove(id)));
    }
    if (g.kind === "marquee") this.host.setSelection(g.base);
    this.host.flushWrite();
    this.host.overlayChanged();
    return true;
  }

  /**
   * A double click: edits the text of the shape under the pointer, or starts
   * a text shape on empty space.
   */
  doubleClick(p: ToolPointer): void {
    const { host } = this;
    if (host.tool() !== "select" || host.doc.readOnly || this.gesture.kind !== "idle") return;
    const hit = host.scene.hit(p.world, HIT_TOLERANCE / host.camera().zoom);
    if (!hit) host.startDraft(this.newShape(newShapeId(), "text", textAt(p.world)));
    else if (holdsText(hit.type)) host.startEditing(hit.id);
  }

  /** Pointer moving with no button down: updates the hover outline and cursor. */
  hover(p: ToolPointer): void {
    if (this.gesture.kind !== "idle") return;
    let hovered: ShapeId | null = null;
    let cursor = "";
    if (this.host.tool() === "select") {
      const frame = this.frame();
      const handle =
        frame && !this.host.doc.readOnly ? handleAt(frame, this.host.camera(), p.screen) : null;
      if (handle?.kind === "resize")
        cursor = resizeCursor(handle.handle, frame?.kind === "box" ? frame.shape.rotation : 0);
      else if (handle?.kind === "rotate") cursor = "grab";
      else if (handle?.kind === "line-end") cursor = "crosshair";
      else
        hovered = this.host.scene.hit(p.world, HIT_TOLERANCE / this.host.camera().zoom)?.id ?? null;
    }
    if (hovered !== this.hoveredId || cursor !== this.hoverCursor) {
      this.hoveredId = hovered;
      this.hoverCursor = cursor;
      this.host.overlayChanged();
    }
  }

  private frame(): SelectionFrame | null {
    const shapes = this.host
      .selection()
      .map((id) => this.host.scene.get(id))
      .filter((s): s is Shape => s !== undefined);
    return selectionFrame(shapes);
  }

  private selectDown(p: ToolPointer): boolean {
    const { host } = this;
    const readOnly = host.doc.readOnly;
    const frame = this.frame();

    const handle = frame && !readOnly ? handleAt(frame, host.camera(), p.screen) : null;
    if (frame && handle) {
      host.doc.checkpoint();
      const before = this.snapshot(host.selection());
      if (handle.kind === "rotate")
        this.gesture = { kind: "rotate", start: p, pivot: frameCenter(frame), before };
      else if (handle.kind === "resize")
        this.gesture = { kind: "resize", start: p, handle: handle.handle, frame, before };
      else if (frame.kind === "line")
        this.gesture = { kind: "line-end", start: p, end: handle.end, before: frame.shape };
      return true;
    }

    const selection = host.selection();
    const hit = host.scene.hit(p.world, HIT_TOLERANCE / host.camera().zoom);
    const onDrag = readOnly ? "none" : "move";
    if (hit) {
      const selected = selection.includes(hit.id);
      if (p.shiftKey) {
        if (!selected) host.setSelection([...selection, hit.id]);
        this.gesture = {
          kind: "pending",
          start: p,
          onDrag,
          // Shift-click on a selected shape deselects it, unless it was dragged.
          ...(selected && {
            onClick: () => host.setSelection(host.selection().filter((id) => id !== hit.id)),
          }),
        };
      } else {
        if (!selected) host.setSelection([hit.id]);
        this.gesture = {
          kind: "pending",
          start: p,
          onDrag,
          // Clicking one shape of a multi-selection picks it alone, unless it was dragged.
          ...(selected && selection.length > 1 && { onClick: () => host.setSelection([hit.id]) }),
        };
      }
      return true;
    }

    // Empty space inside a multi-selection's frame drags the whole selection.
    if (frame?.kind === "group" && insideFrame(frame, host.camera(), p.screen)) {
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
    this.host.doc.checkpoint();
    this.gesture = { kind: "move", start, before: this.snapshot(this.host.selection()) };
  }

  private drag(p: ToolPointer): void {
    const { host } = this;
    const g = this.gesture;
    switch (g.kind) {
      case "move": {
        let dx = p.world.x - g.start.world.x;
        let dy = p.world.y - g.start.world.y;
        if (p.shiftKey) {
          // Lock to the axis with the larger movement.
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        this.write(g.before, (shape) => translate(shape, dx, dy));
        break;
      }
      case "marquee": {
        g.current = p.world;
        const box = boxFromPoints([g.start.world, g.current]);
        const ids = new Set(g.base);
        for (const shape of host.scene.inBox(box)) ids.add(shape.id);
        host.setSelection([...ids]);
        host.overlayChanged();
        break;
      }
      case "resize": {
        const { frame, handle } = g;
        if (frame.kind === "box") {
          const shape = g.before.get(frame.shape.id);
          if (shape) this.write(g.before, () => resizeBox(shape, handle, p.world, p.shiftKey));
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
          this.write(g.before, (shape) => scaleAround(shape, anchor, Math.max(0.01, s)));
        }
        break;
      }
      case "rotate": {
        const angle = (q: Point) => Math.atan2(q.y - g.pivot.y, q.x - g.pivot.x);
        let delta = angle(p.world) - angle(g.start.world);
        if (p.shiftKey) {
          // Snap the resulting angle of a single shape, or the turn of a group.
          const single = g.before.size === 1 ? [...g.before.values()][0] : undefined;
          const base = single && single.type !== "line" ? single.rotation : 0;
          delta = snapAngle(base + delta) - base;
        }
        this.write(g.before, (shape) => rotateAroundPivot(shape, g.pivot, delta));
        break;
      }
      case "line-end": {
        const shape = g.before;
        this.write(new Map([[shape.id, shape]]), () =>
          moveLineEnd(shape, g.end, p.world, p.shiftKey),
        );
        break;
      }
      case "create": {
        const patch = createdGeometry(g.type, g.start.world, p.world, p.shiftKey);
        if (g.id === null) {
          const id = newShapeId();
          g.id = id;
          const shape = this.newShape(id, g.type, patch);
          host.scheduleWrite(() => host.doc.transact((tx) => tx.add(shape)));
          host.flushWrite();
          host.setSelection([id]);
        } else {
          const id = g.id;
          host.scheduleWrite(() => host.doc.transact((tx) => tx.update(id, patch)));
        }
        break;
      }
    }
  }

  private finishCreate(g: Extract<Gesture, { kind: "create" }>, p: ToolPointer): void {
    const { host } = this;
    let id = g.id;
    if (id === null) {
      // A click without a drag drops a default-size shape centered on the pointer.
      id = newShapeId();
      const shape = this.newShape(id, g.type, defaultGeometry(g.type, p.world));
      host.scheduleWrite(() => host.doc.transact((tx) => tx.add(shape)));
    }
    host.flushWrite();
    host.setSelection([id]);
    host.setTool("select");
    // Sticky notes are for writing on.
    if (g.type === "sticky") host.startEditing(id);
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

  private newShape(id: ShapeId, type: ShapeType, geometry: ShapePatch): Shape {
    return {
      id,
      type,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rotation: 0,
      parentId: null,
      index: indexAbove(this.host.scene.ordered()),
      color: DEFAULT_COLOR[type],
      text: "",
      ...geometry,
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
   * Schedules one transaction applying `patch` to every shape in `before`.
   * A text shape's height follows its text, whatever its new width.
   */
  private write(before: Map<ShapeId, Shape>, patch: (shape: Shape) => ShapePatch): void {
    const { host } = this;
    host.scheduleWrite(() =>
      host.doc.transact((tx) => {
        for (const shape of before.values()) {
          let change = patch(shape);
          if (shape.type === "text") {
            const next = { ...shape, ...change };
            change = { ...change, ...withHeight(next, host.fittedHeight(next)) };
          }
          tx.update(shape.id, change);
        }
      }),
    );
  }

  private restore(before: Map<ShapeId, Shape>): void {
    this.write(before, (shape) => {
      const { id: _id, type: _type, text: _text, ...fields } = shape;
      return fields;
    });
  }
}

/** Geometry of a shape dragged out from `from` to `to`. With `constrain`, boxes are square and lines snap to 15°. */
export function createdGeometry(
  type: ShapeType,
  from: Point,
  to: Point,
  constrain: boolean,
): ShapePatch {
  if (type === "line") {
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

function defaultGeometry(type: ShapeType, center: Point): ShapePatch {
  if (type === "line") {
    return { x: center.x - DEFAULT_LINE_LENGTH / 2, y: center.y, w: DEFAULT_LINE_LENGTH, h: 0 };
  }
  const { w, h } = DEFAULT_SIZE[type];
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}
