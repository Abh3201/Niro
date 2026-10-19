export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned box. `minX <= maxX` and `minY <= maxY`. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The visible area of the board, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Rotates `p` by `angle` radians around `center` (clockwise on screen, where y points down). */
export function rotateAround(p: Point, center: Point, angle: number): Point {
  if (angle === 0) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export function boxFromPoints(points: readonly Point[]): Box {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function unionBoxes(boxes: Iterable<Box>): Box | null {
  let result: Box | null = null;
  for (const b of boxes) {
    result = result
      ? {
          minX: Math.min(result.minX, b.minX),
          minY: Math.min(result.minY, b.minY),
          maxX: Math.max(result.maxX, b.maxX),
          maxY: Math.max(result.maxY, b.maxY),
        }
      : { ...b };
  }
  return result;
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** True when `inner` lies entirely inside `outer`, edges included. */
export function boxContainsBox(outer: Box, inner: Box): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

export function boxContainsPoint(box: Box, p: Point): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** True when convex polygon `points` (in order) and `box` overlap. */
export function polygonIntersectsBox(points: readonly Point[], box: Box): boolean {
  if (!boxesIntersect(boxFromPoints(points), box)) return false;
  if (points.some((p) => boxContainsPoint(box, p))) return true;
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  if (points.length >= 3 && corners.some((c) => pointInConvexPolygon(c, points))) return true;
  // No vertex of either inside the other: they overlap only if edges cross.
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    for (let j = 0; j < 4; j++) {
      if (segmentsIntersect(a, b, corners[j] as Point, corners[(j + 1) % 4] as Point)) return true;
    }
  }
  return false;
}

export function pointInConvexPolygon(p: Point, points: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear cases: touching counts as intersecting.
  const onSegment = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, r.x) <= q.x &&
    q.x <= Math.max(p.x, r.x) &&
    Math.min(p.y, r.y) <= q.y &&
    q.y <= Math.max(p.y, r.y);
  return (
    (o1 === 0 && onSegment(a, c, b)) ||
    (o2 === 0 && onSegment(a, d, b)) ||
    (o3 === 0 && onSegment(c, a, d)) ||
    (o4 === 0 && onSegment(c, b, d))
  );
}
