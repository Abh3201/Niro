import { createRandom, type Random } from "./random";

interface Event {
  time: number;
  seq: number;
  run: () => void;
  cancelled: boolean;
}

/**
 * A discrete-event scheduler in virtual time. Nothing waits on a real clock:
 * `run` jumps straight to the next event, so hours of simulated network
 * traffic take milliseconds, and events at the same time run in the order
 * they were scheduled, which keeps every run with the same seed identical.
 */
export class Simulation {
  readonly random: Random;
  private time = 0;
  private seq = 0;
  private readonly queue: Event[] = [];

  constructor(readonly seed: number) {
    this.random = createRandom(seed);
  }

  /** Current virtual time, in milliseconds. */
  get now(): number {
    return this.time;
  }

  /** Number of events waiting to run. */
  get pending(): number {
    return this.queue.filter((e) => !e.cancelled).length;
  }

  /** Runs `fn` after `delay` virtual milliseconds. Returns a function that cancels it. */
  schedule(delay: number, fn: () => void): () => void {
    const event: Event = {
      time: this.time + Math.max(0, delay),
      seq: this.seq++,
      run: fn,
      cancelled: false,
    };
    this.push(event);
    return () => {
      event.cancelled = true;
    };
  }

  /** Runs the next event. Returns false when there is none. */
  step(): boolean {
    for (;;) {
      const event = this.pop();
      if (!event) return false;
      if (event.cancelled) continue;
      this.time = event.time;
      event.run();
      return true;
    }
  }

  /** Runs every event up to and including virtual time `until`, then sets the clock to it. */
  runUntil(until: number): void {
    while (this.queue.length > 0 && (this.peek()?.time ?? Number.POSITIVE_INFINITY) <= until)
      this.step();
    this.time = Math.max(this.time, until);
  }

  /** Advances the clock by `ms`, running everything due on the way. */
  advance(ms: number): void {
    this.runUntil(this.time + ms);
  }

  /**
   * Runs until no events are left. Throws after `maxEvents`, which catches
   * systems that never settle (a retry loop with no backoff, for example).
   */
  runUntilIdle(maxEvents = 1_000_000): void {
    for (let n = 0; n < maxEvents; n++) if (!this.step()) return;
    throw new Error(`still busy after ${maxEvents} events at t=${this.time}ms (seed ${this.seed})`);
  }

  // A binary min-heap ordered by (time, seq).

  private before(a: Event, b: Event): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private peek(): Event | undefined {
    return this.queue[0];
  }

  private push(event: Event): void {
    const q = this.queue;
    q.push(event);
    let i = q.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(q[i] as Event, q[parent] as Event)) break;
      [q[i], q[parent]] = [q[parent] as Event, q[i] as Event];
      i = parent;
    }
  }

  private pop(): Event | undefined {
    const q = this.queue;
    const top = q[0];
    const last = q.pop();
    if (q.length > 0 && last) {
      q[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < q.length && this.before(q[l] as Event, q[smallest] as Event)) smallest = l;
        if (r < q.length && this.before(q[r] as Event, q[smallest] as Event)) smallest = r;
        if (smallest === i) break;
        [q[i], q[smallest]] = [q[smallest] as Event, q[i] as Event];
        i = smallest;
      }
    }
    return top;
  }
}
