import type { Shape } from "@niro/doc";
import type { Box, Point } from "./geometry";

/**
 * Elbow arrows: paths made only of horizontal and vertical segments.
 *
 * The path is never stored. Like an attached end (see `arrows.ts`), it is
 * worked out wherever the arrow is drawn, from the two ends and the boxes
 * of the shapes they're attached to, so a collaborator moving a shape and
 * someone else editing the arrow can't conflict, and every client draws the
 * same path from the same document.
 *
 * Only the shapes the arrow is attached to are routed around. Other shapes
 * in the way are crossed, as a straight arrow crosses them.
 */

/** Space kept clear around the shapes an arrow connects, in world units: room for the head, and for a turn. */
export const ELBOW_CLEARANCE = 24;
/** What a turn costs in the search, in world units of extra length: a straighter path wins unless it's much longer. */
const BEND_COST = 30;
const EPSILON = 1e-6;

/** One end of an elbow arrow. */
export interface RouteEnd {
  /** Where the arrow touches its shape (a little off the side), or the free end's place. */
  readonly point: Point;
  /** The unit direction the arrow leaves the shape in (axis aligned), or null for a free end. */
  readonly heading: Point | null;
  /** The shape's box, which the path keeps clear of. */
  readonly obstacle: Box | null;
}

const DIRECTIONS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];
const NONE = 4;

const directionOf = (v: Point | null): number =>
  v === null ? NONE : DIRECTIONS.findIndex((d) => d.x === v.x && d.y === v.y);

const inflate = (box: Box, by: number): Box => ({
  minX: box.minX - by,
  minY: box.minY - by,
  maxX: box.maxX + by,
  maxY: box.maxY + by,
});

const strictlyInside = (box: Box, p: Point): boolean =>
  p.x > box.minX + EPSILON &&
  p.x < box.maxX - EPSILON &&
  p.y > box.minY + EPSILON &&
  p.y < box.maxY - EPSILON;

/**
 * The route from `a` to `b`: out of `a` in its heading and into `b` against
 * its heading, going around the shapes' boxes, with as few turns as it
 * can manage and no needless length. Returns the corner points, ends included.
 */
export function routeElbow(a: RouteEnd, b: RouteEnd): Point[] {
  const obstacles = [a.obstacle, b.obstacle]
    .filter((box): box is Box => box !== null)
    .map((box) => inflate(box, ELBOW_CLEARANCE));
  // Leave and enter in a straight stub out to the edge of the clear zone.
  const stub = (end: RouteEnd, zone: Box | null): Point => {
    if (!end.heading || !zone) return end.point;
    return end.heading.x !== 0
      ? { x: end.heading.x > 0 ? zone.maxX : zone.minX, y: end.point.y }
      : { x: end.point.x, y: end.heading.y > 0 ? zone.maxY : zone.minY };
  };
  const from = stub(a, a.obstacle && inflate(a.obstacle, ELBOW_CLEARANCE));
  const to = stub(b, b.obstacle && inflate(b.obstacle, ELBOW_CLEARANCE));

  const core = search(from, to, directionOf(a.heading), b.heading, obstacles);
  // The path runs from `from` to `to`: the ends, joined to the stubs where there are any.
  return simplify([a.point, ...(core ?? fallback(from, to, a.heading)), b.point]);
}

/** A Z or L path that ignores the boxes, for when the search finds no way through. */
function fallback(from: Point, to: Point, heading: Point | null): Point[] {
  const horizontalFirst = heading
    ? heading.x !== 0
    : Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  return horizontalFirst
    ? [from, { x: (from.x + to.x) / 2, y: from.y }, { x: (from.x + to.x) / 2, y: to.y }, to]
    : [from, { x: from.x, y: (from.y + to.y) / 2 }, { x: to.x, y: (from.y + to.y) / 2 }, to];
}

/** Drops repeated points and the middle point of any three in a line. */
function simplify(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const last = result.at(-1);
    if (last && Math.abs(last.x - p.x) < EPSILON && Math.abs(last.y - p.y) < EPSILON) continue;
    const before = result.at(-2);
    if (
      last &&
      before &&
      ((Math.abs(before.x - last.x) < EPSILON && Math.abs(last.x - p.x) < EPSILON) ||
        (Math.abs(before.y - last.y) < EPSILON && Math.abs(last.y - p.y) < EPSILON))
    )
      result.pop();
    result.push(p);
  }
  return result.length >= 2 ? result : [points[0] as Point, points.at(-1) as Point];
}

const unique = (values: number[]): number[] => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.filter((v, i) => i === 0 || v - (sorted[i - 1] as number) > EPSILON);
};

/**
 * Cheapest path over the grid made by the lines through the ends and the
 * boxes' edges (any shortest path with few turns can be made to run along
 * them). Cost is length plus `BEND_COST` for each turn, counting a turn at
 * the start away from `heading` and one at the end that isn't into `endHeading`.
 * Null when `to` can't be reached.
 */
function search(
  from: Point,
  to: Point,
  heading: number,
  endHeading: Point | null,
  obstacles: readonly Box[],
): Point[] | null {
  const xs = unique([
    from.x,
    to.x,
    (from.x + to.x) / 2,
    ...obstacles.flatMap((o) => [o.minX, o.maxX]),
  ]);
  const ys = unique([
    from.y,
    to.y,
    (from.y + to.y) / 2,
    ...obstacles.flatMap((o) => [o.minY, o.maxY]),
  ]);
  const at = (i: number, j: number): Point => ({ x: xs[i] as number, y: ys[j] as number });
  const blocked = (p: Point) => obstacles.some((o) => strictlyInside(o, p));
  const index = (values: number[], v: number) => values.findIndex((x) => Math.abs(x - v) < EPSILON);
  const si = index(xs, from.x);
  const sj = index(ys, from.y);
  const gi = index(xs, to.x);
  const gj = index(ys, to.y);
  if (blocked(from) || blocked(to)) return null;

  // Which way the last segment must arrive: into the end shape, against its heading.
  const arrival = endHeading ? directionOf({ x: -endHeading.x, y: -endHeading.y }) : NONE;
  const ny = ys.length;
  const key = (i: number, j: number, d: number) => (i * ny + j) * 5 + d;
  const cost = new Map<number, number>();
  const previous = new Map<number, number>();
  const queue: Array<{ k: number; i: number; j: number; d: number; g: number }> = [];
  const start = key(si, sj, heading);
  cost.set(start, 0);
  queue.push({ k: start, i: si, j: sj, d: heading, g: 0 });

  let best: { k: number; g: number } | null = null;
  while (queue.length > 0) {
    let at0 = 0;
    for (let q = 1; q < queue.length; q++)
      if ((queue[q] as { g: number }).g < (queue[at0] as { g: number }).g) at0 = q;
    const { k, i, j, d, g } = queue.splice(at0, 1)[0] as (typeof queue)[number];
    if (g > (cost.get(k) ?? Number.POSITIVE_INFINITY)) continue;
    if (i === gi && j === gj) {
      const total = g + (arrival !== NONE && d !== arrival && d !== NONE ? BEND_COST : 0);
      if (!best || total < best.g) best = { k, g: total };
      continue;
    }
    for (let nd = 0; nd < 4; nd++) {
      // Never straight back the way it came.
      if (
        d !== NONE &&
        DIRECTIONS[nd]?.x === -(DIRECTIONS[d]?.x as number) &&
        DIRECTIONS[nd]?.y === -(DIRECTIONS[d]?.y as number)
      )
        continue;
      const dir = DIRECTIONS[nd] as Point;
      const ni = i + dir.x;
      const nj = j + dir.y;
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ny) continue;
      const here = at(i, j);
      const there = at(ni, nj);
      const middle = { x: (here.x + there.x) / 2, y: (here.y + there.y) / 2 };
      if (blocked(there) || blocked(middle)) continue;
      const step = Math.abs(there.x - here.x) + Math.abs(there.y - here.y);
      const next = g + step + (d !== NONE && nd !== d ? BEND_COST : 0);
      const nk = key(ni, nj, nd);
      if (next < (cost.get(nk) ?? Number.POSITIVE_INFINITY)) {
        cost.set(nk, next);
        previous.set(nk, k);
        queue.push({ k: nk, i: ni, j: nj, d: nd, g: next });
      }
    }
  }
  if (!best) return null;

  const states: number[] = [];
  for (let k: number | undefined = best.k; k !== undefined; k = previous.get(k)) states.push(k);
  states.reverse();
  return states.map((k) => {
    const cell = Math.floor(k / 5);
    return at(Math.floor(cell / ny), cell % ny);
  });
}

/** Paths worked out for the shapes as drawn, found again by the drawn shape itself. */
const drawnPaths = new WeakMap<Shape, readonly Point[]>();

/** Records the path an arrow, as drawn, follows. */
export function setLinePath(shape: Shape, path: readonly Point[]): void {
  drawnPaths.set(shape, path);
}

/**
 * The points a line or arrow runs through, ends included: two for a straight
 * one, more for an elbow arrow. An elbow arrow that's attached to shapes has
 * its path recorded when it's placed (`resolveArrow`); one that isn't is
 * routed here, between its ends, with nothing in the way.
 */
export function linePoints(shape: Shape): readonly Point[] {
  const known = drawnPaths.get(shape);
  if (known) return known;
  const a = { x: shape.x, y: shape.y };
  const b = { x: shape.x + shape.w, y: shape.y + shape.h };
  if (shape.type !== "arrow" || shape.route !== "elbow") return [a, b];
  const path = routeElbow(
    { point: a, heading: null, obstacle: null },
    { point: b, heading: null, obstacle: null },
  );
  drawnPaths.set(shape, path);
  return path;
}
