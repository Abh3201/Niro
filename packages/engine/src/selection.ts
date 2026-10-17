import type { Shape } from "@niro/doc";
import { type Camera, screenToWorld, worldToScreen } from "./camera";
import { type Box, distance, type Point, rotateAround } from "./geometry";
import { lineEnds, shapeBounds, shapeCenter } from "./shapes";
import { HANDLE_DIRECTIONS, type Handle } from "./transform";

/** Handle size and hit radius, in CSS pixels: handles stay the same size at every zoom. */
export const HANDLE_SIZE = 8;
export const HANDLE_HIT_RADIUS = 10;
/** Distance from the top edge to the rotation handle, in CSS pixels. */
export const ROTATE_HANDLE_OFFSET = 24;

/**
 * What the selection's handles act on:
 * - one box shape: 8 resize handles and a rotate handle in its rotated frame;
 * - one line: a handle on each end;
 * - several shapes: their combined bounding box, scaled uniformly from the
 *   corners and rotated around its center.
 */
export type SelectionFrame =
  | { readonly kind: "box"; readonly shape: Shape }
  | { readonly kind: "line"; readonly shape: Shape }
  | { readonly kind: "group"; readonly bounds: Box };

export type HandleTarget =
  | { readonly kind: "resize"; readonly handle: Handle }
  | { readonly kind: "rotate" }
  | { readonly kind: "line-end"; readonly end: "start" | "end" };

export interface PlacedHandle {
  readonly target: HandleTarget;
  /** Screen position (CSS pixels). */
  readonly at: Point;
}

export function selectionFrame(shapes: readonly Shape[]): SelectionFrame | null {
  const [first] = shapes;
  if (!first) return null;
  if (shapes.length === 1)
    return first.type === "line" ? { kind: "line", shape: first } : { kind: "box", shape: first };
  let box = shapeBounds(first);
  for (const shape of shapes) {
    const b = shapeBounds(shape);
    box = {
      minX: Math.min(box.minX, b.minX),
      minY: Math.min(box.minY, b.minY),
      maxX: Math.max(box.maxX, b.maxX),
      maxY: Math.max(box.maxY, b.maxY),
    };
  }
  return { kind: "group", bounds: box };
}

/** Center of the frame in world coordinates: the pivot for rotation. */
export function frameCenter(frame: SelectionFrame): Point {
  if (frame.kind === "group") {
    const b = frame.bounds;
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  return shapeCenter(frame.shape);
}

/** Corners of the frame outline in world coordinates, clockwise from the top-left. */
export function frameOutline(frame: SelectionFrame): Point[] {
  if (frame.kind === "line") return lineEnds(frame.shape);
  if (frame.kind === "group") {
    const b = frame.bounds;
    return [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ];
  }
  const { shape } = frame;
  const c = shapeCenter(shape);
  return [
    { x: shape.x, y: shape.y },
    { x: shape.x + shape.w, y: shape.y },
    { x: shape.x + shape.w, y: shape.y + shape.h },
    { x: shape.x, y: shape.y + shape.h },
  ].map((p) => rotateAround(p, c, shape.rotation));
}

/** World position of a resize handle on a box shape or group frame. */
export function handleWorldPoint(frame: SelectionFrame, handle: Handle): Point {
  const d = HANDLE_DIRECTIONS[handle];
  if (frame.kind === "group") {
    const b = frame.bounds;
    const c = frameCenter(frame);
    return { x: c.x + (d.x * (b.maxX - b.minX)) / 2, y: c.y + (d.y * (b.maxY - b.minY)) / 2 };
  }
  const { shape } = frame;
  const c = shapeCenter(shape);
  return rotateAround(
    { x: c.x + (d.x * shape.w) / 2, y: c.y + (d.y * shape.h) / 2 },
    c,
    shape.rotation,
  );
}

const BOX_HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const GROUP_HANDLES: readonly Handle[] = ["nw", "ne", "se", "sw"];

/** Every handle of the frame, in screen coordinates. */
export function placeHandles(frame: SelectionFrame, camera: Camera): PlacedHandle[] {
  if (frame.kind === "line") {
    const [a, b] = lineEnds(frame.shape);
    return [
      { target: { kind: "line-end", end: "start" }, at: worldToScreen(camera, a) },
      { target: { kind: "line-end", end: "end" }, at: worldToScreen(camera, b) },
    ];
  }
  const rotation = frame.kind === "box" ? frame.shape.rotation : 0;
  const handles: PlacedHandle[] = (frame.kind === "box" ? BOX_HANDLES : GROUP_HANDLES).map(
    (handle) => ({
      target: { kind: "resize", handle },
      at: worldToScreen(camera, handleWorldPoint(frame, handle)),
    }),
  );
  const top = worldToScreen(camera, handleWorldPoint(frame, "n"));
  // "Up" in the frame's rotated coordinates: (0, -1) turned by its rotation.
  const up = { x: Math.sin(rotation), y: -Math.cos(rotation) };
  handles.push({
    target: { kind: "rotate" },
    at: { x: top.x + up.x * ROTATE_HANDLE_OFFSET, y: top.y + up.y * ROTATE_HANDLE_OFFSET },
  });
  return handles;
}

/** The handle under `screenPoint`, preferring the closest. */
export function handleAt(
  frame: SelectionFrame,
  camera: Camera,
  screenPoint: Point,
): HandleTarget | null {
  let best: HandleTarget | null = null;
  let bestDistance = HANDLE_HIT_RADIUS;
  for (const { target, at } of placeHandles(frame, camera)) {
    const d = distance(at, screenPoint);
    if (d <= bestDistance) {
      best = target;
      bestDistance = d;
    }
  }
  return best;
}

/** True when `screenPoint` is inside the frame's outline (used to drag a selection by its body). */
export function insideFrame(frame: SelectionFrame, camera: Camera, screenPoint: Point): boolean {
  if (frame.kind === "line") return false;
  const p = screenToWorld(camera, screenPoint);
  if (frame.kind === "group") {
    const b = frame.bounds;
    return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
  }
  const { shape } = frame;
  const c = shapeCenter(shape);
  const local = rotateAround(p, c, -shape.rotation);
  return Math.abs(local.x - c.x) <= shape.w / 2 && Math.abs(local.y - c.y) <= shape.h / 2;
}

const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/** A resize cursor matching the handle's direction on screen, after rotation. */
export function resizeCursor(handle: Handle, rotation: number): string {
  const d = HANDLE_DIRECTIONS[handle];
  const angle = Math.atan2(d.y, d.x) + rotation;
  // Four cursor directions, each covering 45°; opposite directions share a cursor.
  const step = Math.round(angle / (Math.PI / 4));
  return RESIZE_CURSORS[((step % 4) + 4) % 4] as string;
}
