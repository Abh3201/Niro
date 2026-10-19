/**
 * A timestamp that orders events without trusting anyone's wall clock: a
 * counter, plus the peer that made it to break ties. Two different events
 * never get the same stamp, so every pair of stamps has a winner, and
 * every replica picks the same one.
 */
export interface Stamp {
  readonly counter: number;
  readonly peer: string;
}

/** Negative if `a` came first, positive if `b` did, 0 for the same stamp. */
export function compare(a: Stamp, b: Stamp): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0;
}

export const sameStamp = (a: Stamp, b: Stamp) => compare(a, b) === 0;

/** A stamp as a map key. */
export const key = (s: Stamp) => `${s.counter}@${s.peer}`;

/** Where stamps come from. Lamport's clock is the right one; `WallClock` is here to show why. */
export interface Clock {
  /** A stamp for a new event, later than everything this peer has made or seen. */
  tick(): Stamp;
  /** Notes a stamp from someone else. */
  observe(stamp: Stamp): void;
}

/**
 * Lamport's logical clock (1978). Each peer counts its own events, and on
 * seeing someone else's stamp it jumps its count past it. So anything a
 * peer does after seeing an event gets a bigger stamp than that event:
 * if A could have known about B, A > B. Concurrent events (neither knew
 * of the other) get an arbitrary but agreed order.
 */
export class LamportClock implements Clock {
  private counter = 0;

  constructor(readonly peer: string) {}

  tick(): Stamp {
    this.counter += 1;
    return { counter: this.counter, peer: this.peer };
  }

  observe(stamp: Stamp): void {
    this.counter = Math.max(this.counter, stamp.counter);
  }
}

/**
 * Stamps from a wall clock, as `Date.now()` would give them. Fine while
 * clocks agree; when one runs fast, its edits beat edits made after them,
 * for as long as it stays fast. See the test "loses a later edit to a
 * clock that runs fast".
 */
export class WallClock implements Clock {
  constructor(
    readonly peer: string,
    private readonly now: () => number,
  ) {}

  tick(): Stamp {
    return { counter: this.now(), peer: this.peer };
  }

  observe(): void {}
}
