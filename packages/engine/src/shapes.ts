import { isLinear, type Shape } from "@niro/doc";
import { hitStroke } from "./freehand";
import {
  type Box,
  boxFromPoints,
  distanceToSegment,
  type Point,
  polygonIntersectsBox,
  rotateAround,
} from "./geometry";
import { LINE_WIDTH, lineWidthOf } from "./line-style";
import { FRAME_LABEL_HEIGHT } from "./text";

/** Geometry of shapes in world coordinates. See `Shape` for what x, y, w, h mean per type. */

export function shapeCenter(shape: Shape): Point {
  return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
}

export function lineEnds(shape: Shape): [Point, Point] {
  return [
    { x: shape.x, y: shape.y },
    { x: shape.x + shape.w, y: shape.y + shape.h },
  ];
}

/** Corners of a box shape after rotation, clockwise from the top-left; a line's or arrow's two ends. */
export function shapeOutline(shape: Shape): Point[] {
  if (isLinear(shape.type)) return lineEnds(shape);
  const { x, y, w, h, rotation } = shape;
  const center = shapeCenter(shape);
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ].map((p) => rotateAround(p, center, rotation));
}

export function shapeBounds(shape: Shape): Box {
  return boxFromPoints(shapeOutline(shape));
}

/**
 * The box a shape can be hit or selected in: its outline's box, and for a
 * frame the band above it where its name is picked.
 */
export function shapeExtent(shape: Shape): Box {
  const box = shapeBounds(shape);
  return shape.type === "frame" ? { ...box, minY: box.minY - FRAME_LABEL_HEIGHT } : box;
}

/** `p` in the shape's own frame: origin at its center, axes along its unrotated sides. */
export function toShapeFrame(shape: Shape, p: Point): Point {
  const c = shapeCenter(shape);
  const local = rotateAround(p, c, -shape.rotation);
  return { x: local.x - c.x, y: local.y - c.y };
}

/**
 * True when `p` is on the shape. `tolerance` (world units) widens the target
 * so thin lines and edges stay easy to hit at any zoom.
 */
export function hitShape(shape: Shape, p: Point, tolerance: number): boolean {
  // A group is picked through what's in it.
  if (shape.type === "group") return false;
  if (isLinear(shape.type)) {
    const [a, b] = lineEnds(shape);
    // A thicker line is wider to hit than the default one the tolerance is for.
    return (
      distanceToSegment(p, a, b) <= tolerance + Math.max(0, (lineWidthOf(shape) - LINE_WIDTH) / 2)
    );
  }
  const local = toShapeFrame(shape, p);
  const rx = shape.w / 2 + tolerance;
  const ry = shape.h / 2 + tolerance;
  if (shape.type === "ellipse") return (local.x / rx) ** 2 + (local.y / ry) ** 2 <= 1;
  const inBox = Math.abs(local.x) <= rx && Math.abs(local.y) <= ry;
  // A frame is picked by its name or its edge: inside, a press is on the board
  // (or on what's in the frame), so a marquee can start there.
  if (shape.type === "frame") {
    const hw = shape.w / 2;
    const hh = shape.h / 2;
    const onLabel =
      Math.abs(local.x) <= hw && local.y >= -hh - FRAME_LABEL_HEIGHT && local.y <= -hh;
    const inside = Math.abs(local.x) < hw - tolerance && Math.abs(local.y) < hh - tolerance;
    return onLabel || (inBox && !inside);
  }
  // A stroke is hit on its ink, not anywhere in its box.
  if (shape.type === "freehand") return inBox && hitStroke(shape, local, tolerance);
  return inBox;
}

/**
 * True when the shape overlaps `box`, for marquee selection. Ellipses are
 * treated as their rotated bounding rectangle, which can select an ellipse
 * when only the box's corner region is touched.
 */
export function shapeIntersectsBox(shape: Shape, box: Box): boolean {
  return polygonIntersectsBox(shapeOutline(shape), box);
}
