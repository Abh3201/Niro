import type { ShapeId } from "@niro/doc";
import type { View } from "./follow";
import type { Point } from "./geometry";

/** Someone else on the board, as the engine draws them. Never part of the document. */
export interface RemotePeer {
  /** Stable for as long as they're connected. */
  readonly id: number;
  readonly name: string;
  /** A CSS color dark enough to carry white text: their cursor, label and selection. */
  readonly color: string;
  /** Their pointer in world coordinates, or null when it isn't over the board. */
  readonly cursor: Point | null;
  readonly selection: readonly ShapeId[];
  /** Where their laser pointer is, in world coordinates, while they hold it down. */
  readonly laser?: Point | null;
  /** They are presenting: stepping through the frames, with everyone able to follow. */
  readonly presenting?: boolean;
  /** The part of the board they see, for following them; null while they follow someone themselves. */
  readonly view?: View | null;
}

/**
 * How quickly a drawn cursor closes on its latest reported position, in ms:
 * after this long it has covered about 63% of the distance.
 *
 * Cursors arrive at 20 Hz, so drawn as received they jump every 50 ms.
 * Easing toward each new position hides the steps for about one update's
 * worth of lag.
 */
export const CURSOR_SMOOTHING_MS = 60;

interface Track {
  at: Point;
  target: Point;
}

/** Remote cursors, each easing toward the last position its peer reported. */
export class SmoothedCursors {
  private readonly tracks = new Map<number, Track>();

  /**
   * Sets where each cursor is heading. A cursor that wasn't shown appears at
   * its target; peers that are gone or off the board are dropped.
   */
  retarget(peers: readonly RemotePeer[]): void {
    const seen = new Set<number>();
    for (const { id, cursor } of peers) {
      if (!cursor) continue;
      seen.add(id);
      const track = this.tracks.get(id);
      if (track) track.target = cursor;
      else this.tracks.set(id, { at: cursor, target: cursor });
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
  }

  /**
   * Advances every cursor by `elapsedMs`. Cursors within `epsilon` (world
   * units) of their target land on it. Returns true if any cursor moved.
   */
  step(elapsedMs: number, epsilon: number): boolean {
    const blend = 1 - Math.exp(-elapsedMs / CURSOR_SMOOTHING_MS);
    let moved = false;
    for (const track of this.tracks.values()) {
      const { at, target } = track;
      if (at.x === target.x && at.y === target.y) continue;
      moved = true;
      const next = { x: at.x + (target.x - at.x) * blend, y: at.y + (target.y - at.y) * blend };
      track.at = Math.hypot(target.x - next.x, target.y - next.y) <= epsilon ? target : next;
    }
    return moved;
  }

  /** Where to draw a peer's cursor now, if it has one. */
  position(id: number): Point | undefined {
    return this.tracks.get(id)?.at;
  }
}
