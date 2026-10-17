import { isLinear, MIN_SIZE, normalizeAngle, type Shape, type ShapePatch } from "@niro/doc";
import { type Point, rotateAround } from "./geometry";
import { lineEnds, shapeCenter, toShapeFrame } from "./shapes";

/**
 * Pure math for move, resize and rotate gestures. Each function takes the
 * shape as it was when the gesture started plus the pointer now, and returns
 * the fields to write, so a gesture never accumulates rounding error.
 */

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Where each handle sits on a box, in units of half the width and height. */
export const HANDLE_DIRECTIONS: Readonly<Record<Handle, Point>> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

export const ROTATION_SNAP = Math.PI / 12; // 15 degrees

export function snapAngle(angle: number, step = ROTATION_SNAP): number {
  return Math.round(angle / step) * step;
}

export function translate(shape: Shape, dx: number, dy: number): ShapePatch {
  return { x: shape.x + dx, y: shape.y + dy };
}

/**
 * Resizes a box shape by dragging `handle` to world point `p`, in the shape's
 * own rotated frame. The opposite edge or corner stays where it is. With
 * `keepAspect`, corners scale uniformly and edges scale the other axis around
 * the center. Dragging past the opposite side flips the box.
 */
export function resizeBox(shape: Shape, handle: Handle, p: Point, keepAspect: boolean): ShapePatch {
  const dir = HANDLE_DIRECTIONS[handle];
  const local = toShapeFrame(shape, p);
  let left = -shape.w / 2;
  let right = shape.w / 2;
  let top = -shape.h / 2;
  let bottom = shape.h / 2;
  if (dir.x === 1) right = local.x;
  if (dir.x === -1) left = local.x;
  if (dir.y === 1) bottom = local.y;
  if (dir.y === -1) top = local.y;

  if (keepAspect) {
    const w = right - left;
    const h = bottom - top;
    if (dir.x !== 0 && dir.y !== 0) {
      const s = Math.max(Math.abs(w) / shape.w, Math.abs(h) / shape.h);
      const sw = (Math.sign(w) || 1) * shape.w * s;
      const sh = (Math.sign(h) || 1) * shape.h * s;
      if (dir.x === 1) right = left + sw;
      else left = right - sw;
      if (dir.y === 1) bottom = top + sh;
      else top = bottom - sh;
    } else if (dir.x !== 0) {
      const half = (shape.h * Math.abs(w)) / shape.w / 2;
      top = -half;
      bottom = half;
    } else {
      const half = (shape.w * Math.abs(h)) / shape.h / 2;
      left = -half;
      right = half;
    }
  }

  const w = Math.max(MIN_SIZE, Math.abs(right - left));
  const h = Math.max(MIN_SIZE, Math.abs(bottom - top));
  const c0 = shapeCenter(shape);
  const localCenter = { x: c0.x + (left + right) / 2, y: c0.y + (top + bottom) / 2 };
  const center = rotateAround(localCenter, c0, shape.rotation);
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}

/** Moves one end of a line to `p`. With `snap`, the line's angle snaps to 15° steps. */
export function moveLineEnd(
  shape: Shape,
  end: "start" | "end",
  p: Point,
  snap: boolean,
): ShapePatch {
  const [start, finish] = lineEnds(shape);
  const fixed = end === "start" ? finish : start;
  const moved = snap ? snapAround(fixed, p) : p;
  return end === "start"
    ? { x: moved.x, y: moved.y, w: fixed.x - moved.x, h: fixed.y - moved.y }
    : { w: moved.x - fixed.x, h: moved.y - fixed.y };
}

/** `p` moved so the direction from `origin` is a multiple of 15°, keeping its distance. */
export function snapAround(origin: Point, p: Point): Point {
  const length = Math.hypot(p.x - origin.x, p.y - origin.y);
  const angle = snapAngle(Math.atan2(p.y - origin.y, p.x - origin.x));
  return { x: origin.x + length * Math.cos(angle), y: origin.y + length * Math.sin(angle) };
}

/** Scales a shape uniformly by `s` around `anchor` (multi-selection resize). */
export function scaleAround(shape: Shape, anchor: Point, s: number): ShapePatch {
  if (isLinear(shape.type)) {
    return {
      x: anchor.x + (shape.x - anchor.x) * s,
      y: anchor.y + (shape.y - anchor.y) * s,
      w: shape.w * s,
      h: shape.h * s,
    };
  }
  const c = shapeCenter(shape);
  const w = Math.max(MIN_SIZE, shape.w * s);
  const h = Math.max(MIN_SIZE, shape.h * s);
  const center = { x: anchor.x + (c.x - anchor.x) * s, y: anchor.y + (c.y - anchor.y) * s };
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}

/** Rotates a shape by `delta` radians around `pivot`. Lines rotate their end points. */
export function rotateAroundPivot(shape: Shape, pivot: Point, delta: number): ShapePatch {
  if (isLinear(shape.type)) {
    const [a, b] = lineEnds(shape).map((p) => rotateAround(p, pivot, delta)) as [Point, Point];
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  const center = rotateAround(shapeCenter(shape), pivot, delta);
  return {
    x: center.x - shape.w / 2,
    y: center.y - shape.h / 2,
    rotation: normalizeAngle(shape.rotation + delta),
  };
}
