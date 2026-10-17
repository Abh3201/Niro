import type { Shape } from "@niro/doc";
import {
  type Box,
  boxFromPoints,
  distanceToSegment,
  type Point,
  polygonIntersectsBox,
  rotateAround,
} from "./geometry";

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

/** Corners of a box shape after rotation, clockwise from the top-left; a line's two ends. */
export function shapeOutline(shape: Shape): Point[] {
  if (shape.type === "line") return lineEnds(shape);
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
  if (shape.type === "line") {
    const [a, b] = lineEnds(shape);
    return distanceToSegment(p, a, b) <= tolerance;
  }
  const local = toShapeFrame(shape, p);
  const rx = shape.w / 2 + tolerance;
  const ry = shape.h / 2 + tolerance;
  if (shape.type === "ellipse") return (local.x / rx) ** 2 + (local.y / ry) ** 2 <= 1;
  return Math.abs(local.x) <= rx && Math.abs(local.y) <= ry;
}

/**
 * True when the shape overlaps `box`, for marquee selection. Ellipses are
 * treated as their rotated bounding rectangle, which can select an ellipse
 * when only the box's corner region is touched.
 */
export function shapeIntersectsBox(shape: Shape, box: Box): boolean {
  return polygonIntersectsBox(shapeOutline(shape), box);
}
