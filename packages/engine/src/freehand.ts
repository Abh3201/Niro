import { POINT_SCALE, PRESSURE_SCALE, type Shape, type ShapeId } from "@niro/doc";
import { getStroke } from "perfect-freehand";
import { distanceToSegment, type Point } from "./geometry";

/**
 * Freehand strokes. The pen's points are kept as drawn; perfect-freehand
 * turns them into the outline of a stroke that thins and thickens with
 * pressure (or, without a pressure-sensing pen, with speed), and that
 * outline is filled.
 */

/** Stroke thickness, in world units. */
export const PEN_SIZE = 6;
/** The pressure mice, fingers and pens without pressure report. */
const NO_PRESSURE = 0.5;

/** A point the pen passed through, in world units, with pressure from 0 to 1. */
export interface PenPoint {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

const options = (simulatePressure: boolean, last: boolean) => ({
  size: PEN_SIZE,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure,
  last,
});

/**
 * The box and stored points of a stroke through `points`. The box has
 * room for the stroke's thickness, so a straight line still has height.
 */
export function strokeShape(
  points: readonly PenPoint[],
): Pick<Shape, "x" | "y" | "w" | "h" | "points"> {
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
  const pad = PEN_SIZE / 2 + 1;
  const x = minX - pad;
  const y = minY - pad;
  const w = maxX - minX + 2 * pad;
  const h = maxY - minY + 2 * pad;
  const stored: number[] = [];
  for (const p of points) {
    stored.push(
      Math.round(((p.x - x) / w) * POINT_SCALE),
      Math.round(((p.y - y) / h) * POINT_SCALE),
      Math.round(Math.min(1, Math.max(0, p.pressure)) * PRESSURE_SCALE),
    );
  }
  return { x, y, w, h, points: stored };
}

/** A stroke's points in its own frame: origin at the box's center, before rotation. */
export function localPenPoints(shape: Shape): PenPoint[] {
  const { points, w, h } = shape;
  const result: PenPoint[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    result.push({
      x: ((points[i] as number) / POINT_SCALE - 0.5) * w,
      y: ((points[i + 1] as number) / POINT_SCALE - 0.5) * h,
      pressure: (points[i + 2] as number) / PRESSURE_SCALE,
    });
  }
  return result;
}

/**
 * The outline of a stroke through `points`, to fill. Strokes whose points
 * all have the same pressure didn't sense it: their width follows speed.
 */
export function strokeOutline(points: readonly PenPoint[], last = true): Point[] {
  const first = points[0];
  if (!first) return [];
  const sensed = points.some((p) => Math.abs(p.pressure - first.pressure) > 1e-6);
  const input = points.map((p) => [p.x, p.y, sensed ? p.pressure : NO_PRESSURE]);
  return getStroke(input, options(!sensed, last)).map(([x, y]) => ({ x, y }));
}

/** Traces a stroke outline into `path`, smoothed with curves through the midpoints. */
export function traceOutline(
  path: Pick<CanvasPath, "moveTo" | "quadraticCurveTo" | "closePath">,
  outline: readonly Point[],
): void {
  const n = outline.length;
  const first = outline[0];
  if (!first || n < 3) return;
  path.moveTo(first.x, first.y);
  for (let i = 0; i < n; i++) {
    const a = outline[i] as Point;
    const b = outline[(i + 1) % n] as Point;
    path.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  path.closePath();
}

/** True when `local`, a point in the stroke's own frame, is within `tolerance` of the stroke. */
export function hitStroke(shape: Shape, local: Point, tolerance: number): boolean {
  const points = localPenPoints(shape);
  const reach = tolerance + PEN_SIZE / 2;
  if (points.length === 1) {
    const only = points[0] as PenPoint;
    return Math.hypot(local.x - only.x, local.y - only.y) <= reach;
  }
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(local, points[i - 1] as PenPoint, points[i] as PenPoint) <= reach)
      return true;
  }
  return false;
}

/** Filled stroke outlines, built once per stroke and size. */
export class StrokePaths {
  private readonly cache = new Map<ShapeId, { key: string; path: Path2D }>();

  get(shape: Shape): Path2D {
    const { points } = shape;
    // Points never change after a stroke is added; the size does.
    const key = `${shape.w}|${shape.h}|${points.length}|${points[0]}|${points[points.length - 1]}`;
    const cached = this.cache.get(shape.id);
    if (cached?.key === key) return cached.path;
    const path = new Path2D();
    traceOutline(path, strokeOutline(localPenPoints(shape)));
    // Deleted strokes are never evicted one by one: forget everything now and then.
    if (!cached && this.cache.size >= 10_000) this.cache.clear();
    this.cache.set(shape.id, { key, path });
    return path;
  }
}
