import { type Clock, compare, LamportClock, type Stamp } from "./clock";

/**
 * One key's latest write. It is both the op a peer sends and the state a
 * replica keeps, so "send me your ops" and "send me your state" are the
 * same message. `value` undefined means the key was deleted: the entry
 * stays as a tombstone, or an older write arriving late would bring the
 * key back.
 */
export interface Entry<V> {
  readonly key: string;
  readonly value: V | undefined;
  readonly stamp: Stamp;
}

/**
 * A last-writer-wins map. Each key keeps the write with the biggest stamp.
 * "Biggest of" doesn't care about order or repeats, which is the whole
 * trick: replicas that have seen the same writes, in any order, any number
 * of times, hold the same map.
 */
export class LwwMap<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(private readonly clock: Clock) {}

  static lamport<V>(peer: string): LwwMap<V> {
    return new LwwMap<V>(new LamportClock(peer));
  }

  set(key: string, value: V): Entry<V> {
    return this.write(key, value);
  }

  delete(key: string): Entry<V> {
    return this.write(key, undefined);
  }

  /** Takes in a write from any replica. Returns true if it's now the key's value. */
  apply(entry: Entry<V>): boolean {
    this.clock.observe(entry.stamp);
    const current = this.entries.get(entry.key);
    if (current && compare(current.stamp, entry.stamp) >= 0) return false;
    this.entries.set(entry.key, entry);
    return true;
  }

  /** Takes in everything another replica has. */
  merge(other: LwwMap<V>): void {
    for (const entry of other.state()) this.apply(entry);
  }

  get(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** The live keys and values, sorted by key so two replicas print the same. */
  toObject(): Record<string, V> {
    const result: Record<string, V> = {};
    for (const k of [...this.entries.keys()].sort()) {
      const value = this.entries.get(k)?.value;
      if (value !== undefined) result[k] = value;
    }
    return result;
  }

  /** Every entry, tombstones included. */
  state(): Entry<V>[] {
    return [...this.entries.values()];
  }

  private write(key: string, value: V | undefined): Entry<V> {
    const entry: Entry<V> = { key, value, stamp: this.clock.tick() };
    this.apply(entry);
    return entry;
  }
}
