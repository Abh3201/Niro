import type { Box } from "./geometry";

/**
 * Snapping while a selection is dragged: its edges and center line up with
 * the edges and centers of other shapes, and a guide line shows what it
 * lined up with.
 *
 * The tolerance is given in world units but chosen in screen pixels (see
 * `SNAP_PX`): at any zoom, a shape sticks when it's a few pixels from
 * lining up, not a few units.
 */

/** How close, in CSS pixels, an edge or center must be to a target's to snap to it. */
export const SNAP_PX = 6;

/** A guide line, in world coordinates: vertical (`axis` "x") at `at`, or horizontal ("y"), from `from` to `to` along it. */
export interface Guide {
  readonly axis: "x" | "y";
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

export interface Snap {
  /** The extra movement that lines the box up. */
  readonly dx: number;
  readonly dy: number;
  readonly guides: readonly Guide[];
}

/** Boxes with more targets than this are matched against the first ones only: a snap is a convenience, a drag must stay at 60 fps. */
export const MAX_TARGETS = 2_000;

/** Two lines closer than this (world units) are the same line, for guides. */
const SAME = 1e-6;

/** The three lines of a box along one axis: low edge, middle, high edge. */
const lines = (low: number, high: number): [number, number, number] => [
  low,
  (low + high) / 2,
  high,
];

interface Match {
  /** How far the box must move to line up. */
  delta: number;
  /** Where the line is, once it has. */
  at: number;
}

/** The smallest move, within `tolerance`, that puts a line of `moving` on a line of one of `targets`. */
function nearest(
  moving: readonly number[],
  targets: Iterable<readonly number[]>,
  tolerance: number,
): Match | null {
  let best: Match | null = null;
  for (const target of targets) {
    for (const t of target) {
      for (const m of moving) {
        const delta = t - m;
        if (Math.abs(delta) <= tolerance && (!best || Math.abs(delta) < Math.abs(best.delta)))
          best = { delta, at: t };
      }
    }
  }
  return best;
}

/**
 * How to nudge `moving` so it lines up with `targets`, and the guides to
 * draw. An axis in `free` is left alone when false (a drag locked to the
 * other axis).
 */
export function snapBox(
  moving: Box,
  targets: readonly Box[],
  tolerance: number,
  free: { x: boolean; y: boolean } = { x: true, y: true },
): Snap {
  const used = targets.slice(0, MAX_TARGETS);
  const xs = nearest(
    lines(moving.minX, moving.maxX),
    used.map((b) => lines(b.minX, b.maxX)),
    free.x ? tolerance : -1,
  );
  const ys = nearest(
    lines(moving.minY, moving.maxY),
    used.map((b) => lines(b.minY, b.maxY)),
    free.y ? tolerance : -1,
  );
  const dx = xs?.delta ?? 0;
  const dy = ys?.delta ?? 0;
  const at: Box = {
    minX: moving.minX + dx,
    maxX: moving.maxX + dx,
    minY: moving.minY + dy,
    maxY: moving.maxY + dy,
  };
  const guides: Guide[] = [];
  if (xs) guides.push(...guidesFor("x", at, used));
  if (ys) guides.push(...guidesFor("y", at, used));
  return { dx, dy, guides };
}

/** Every line, on `axis`, that the moved box shares with a target, drawn across both. */
function guidesFor(axis: "x" | "y", moved: Box, targets: readonly Box[]): Guide[] {
  const [low, high] = axis === "x" ? [moved.minX, moved.maxX] : [moved.minY, moved.maxY];
  const mine = lines(low, high);
  // The extent along the other axis of the box and each target on a line.
  const spans = new Map<number, { from: number; to: number }>();
  const along = (b: Box) => (axis === "x" ? [b.minY, b.maxY] : [b.minX, b.maxX]);
  const [mFrom, mTo] = along(moved) as [number, number];
  for (const target of targets) {
    const [tLow, tHigh] = axis === "x" ? [target.minX, target.maxX] : [target.minY, target.maxY];
    const [tFrom, tTo] = along(target) as [number, number];
    for (const t of lines(tLow, tHigh)) {
      const m = mine.find((line) => Math.abs(line - t) <= SAME);
      if (m === undefined) continue;
      const key = Math.round(t / SAME) * SAME;
      const span = spans.get(key) ?? { from: Math.min(mFrom, tFrom), to: Math.max(mTo, tTo) };
      span.from = Math.min(span.from, tFrom);
      span.to = Math.max(span.to, tTo);
      spans.set(key, span);
    }
  }
  return [...spans].map(([at, { from, to }]) => ({ axis, at, from, to }));
}
