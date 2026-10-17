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
