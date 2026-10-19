/**
 * A token bucket: holds up to `burst` tokens and refills at `rate` per
 * second. Each message (or byte) takes one; when the bucket is empty, the
 * sender is over the limit. Short bursts pass, a steady flood doesn't.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = performance.now.bind(performance),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Takes `n` tokens if there are that many. */
  take(n = 1): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
