import { isLinear, type Shape, type ShapeId, type ShapePatch } from "@niro/doc";
import type { Point } from "./geometry";
import { shapeCenter } from "./shapes";

/**
 * Arrows attached to shapes. An attached end isn't stored where it's drawn:
 * it's worked out, whenever either shape changes, as the point where the
 * line between the two ends leaves the shape. So moving a shape never
 * writes to its arrows, and someone moving a shape while someone else
 * attaches an arrow to it can't conflict.
 */

/** Space between an attached end and its shape's outline, in world units. */
export const ATTACH_GAP = 8;

/** Arrows attach to boxes: anything but lines and other arrows. */
export function canAttachTo(shape: Shape): boolean {
  return !isLinear(shape.type);
}

/**
 * How far from a shape's center, along the unit vector `d`, its outline is.
 * Freehand strokes and text count as their boxes.
 */
export function outlineDistance(shape: Shape, d: Point): number {
  const cos = Math.cos(shape.rotation);
  const sin = Math.sin(shape.rotation);
  // `d` in the shape's own frame.
  const x = d.x * cos + d.y * sin;
  const y = -d.x * sin + d.y * cos;
  const hw = shape.w / 2;
  const hh = shape.h / 2;
  if (shape.type === "ellipse") return 1 / Math.hypot(x / hw, y / hh);
  return Math.min(x === 0 ? Infinity : hw / Math.abs(x), y === 0 ? Infinity : hh / Math.abs(y));
}

/**
 * `arrow` with its attached ends placed: each on its shape's outline (plus a
 * gap), on the line toward the other end. An end attached to a shape that's
 * gone stays where it was stored. Other shapes come back unchanged.
 */
export function resolveArrow(arrow: Shape, get: (id: ShapeId) => Shape | undefined): Shape {
  if (arrow.type !== "arrow") return arrow;
  const attached = (id: ShapeId | null) => {
    const shape = id === null ? undefined : get(id);
    return shape && shape.id !== arrow.id && canAttachTo(shape) ? shape : undefined;
  };
  const from = attached(arrow.from);
  const to = attached(arrow.to);
  if (!from && !to) return arrow;

  const start = from ? shapeCenter(from) : { x: arrow.x, y: arrow.y };
  const end = to ? shapeCenter(to) : { x: arrow.x + arrow.w, y: arrow.y + arrow.h };
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 1e-9) return { ...arrow, x: start.x, y: start.y, w: 0, h: 0 };
  const d = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const startGap = from ? outlineDistance(from, d) + ATTACH_GAP : 0;
  const endGap = to ? outlineDistance(to, { x: -d.x, y: -d.y }) + ATTACH_GAP : 0;
  // Shapes too close or overlapping leave no room between their outlines:
  // then the arrow runs between the ends themselves.
  const room = length - startGap - endGap > 0;
  const a = room ? { x: start.x + d.x * startGap, y: start.y + d.y * startGap } : start;
  const b = room ? { x: end.x - d.x * endGap, y: end.y - d.y * endGap } : end;
  return { ...arrow, x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/**
 * Detaches an arrow's ends from shapes `keep` says no to: for an arrow
 * moved, resized or turned without the shapes it points at, whose ends
 * should go where it's put rather than snap back. Nothing for other shapes.
 */
export function detachUnless(shape: Shape, keep: (id: ShapeId) => boolean): ShapePatch {
  if (shape.type !== "arrow") return {};
  const patch: { from?: null; to?: null } = {};
  if (shape.from !== null && !keep(shape.from)) patch.from = null;
  if (shape.to !== null && !keep(shape.to)) patch.to = null;
  return patch;
}

/**
 * Where an attached arrow is drawn, as a patch: write it with any change
 * to the arrow's geometry, which is made to the arrow as drawn. Its stored
 * ends are only where they were last placed, so a move or a dragged end
 * applied to them would put its free end in the wrong place. Nothing for
 * other shapes.
 */
export function asDrawn(shape: Shape): ShapePatch {
  if (shape.type !== "arrow" || (shape.from === null && shape.to === null)) return {};
  const { x, y, w, h } = shape;
  return { x, y, w, h };
}
