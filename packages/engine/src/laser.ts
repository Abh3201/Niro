import type { Point } from "./geometry";

/**
 * The laser pointer: a trail that fades. Nothing about it is stored: each
 * client draws the points it's told about (its own, and the ones others
 * share through presence) and lets them age out.
 */

/** How long a point of the trail stays visible, in ms. */
export const LASER_LIFETIME_MS = 1000;
/** Most points kept per trail: a pointer moving fast makes many. */
const MAX_POINTS = 64;

export interface LaserPoint extends Point {
  /** When it was added, on the same clock as the `now` given to `add` and `step`. */
  readonly t: number;
}

/** Whose trail: a peer's id, or `"me"`. */
export type LaserKey = number | "me";

export class LaserTrails {
  private readonly trails = new Map<LaserKey, LaserPoint[]>();
  /** Pointers still held down: the end of their trails stays lit while they rest. */
  private readonly held = new Set<LaserKey>();

  /** Marks whether `key`'s pointer is held down. */
  hold(key: LaserKey, held: boolean): void {
    if (held) this.held.add(key);
    else this.held.delete(key);
  }

  /** Adds a point to `key`'s trail, unless it's where the trail already ends. */
  add(key: LaserKey, p: Point, now: number): void {
    let trail = this.trails.get(key);
    if (!trail) {
      trail = [];
      this.trails.set(key, trail);
    }
    const last = trail.at(-1);
    if (last && last.x === p.x && last.y === p.y) return;
    trail.push({ x: p.x, y: p.y, t: now });
    if (trail.length > MAX_POINTS) trail.shift();
  }

  /**
   * Drops points older than the lifetime. Returns true while there is
   * anything to redraw: a trail was on screen before this step, even if it
   * has just gone (one more frame clears it).
   */
  step(now: number): boolean {
    const lit = this.trails.size > 0;
    for (const key of this.held) {
      const trail = this.trails.get(key);
      const last = trail?.at(-1);
      if (trail && last) trail[trail.length - 1] = { x: last.x, y: last.y, t: now };
    }
    for (const [key, trail] of this.trails) {
      let old = 0;
      while (old < trail.length && now - (trail[old] as LaserPoint).t >= LASER_LIFETIME_MS) old++;
      if (old > 0) trail.splice(0, old);
      if (trail.length === 0) this.trails.delete(key);
    }
    return lit;
  }

  /** Forgets a trail (a peer who left). */
  remove(key: LaserKey): void {
    this.trails.delete(key);
    this.held.delete(key);
  }

  entries(): IterableIterator<[LaserKey, readonly LaserPoint[]]> {
    return this.trails.entries();
  }
}

/** How opaque a point `age` ms old is: fully at first, then fading to nothing. */
export function laserAlpha(age: number): number {
  return Math.max(0, 1 - age / LASER_LIFETIME_MS) ** 1.5;
}
