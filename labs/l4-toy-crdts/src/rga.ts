import { compare, key, LamportClock, type Stamp } from "./clock";

/**
 * RGA's two ops. A character is never named by its position, which shifts
 * as others type, but by the stamp it was inserted with, which doesn't.
 */
export type RgaOp =
  /** `char`, stamped `id`, goes right after the character `after` (null: the start). */
  | {
      readonly type: "insert";
      readonly id: Stamp;
      readonly after: Stamp | null;
      readonly char: string;
    }
  /** The character `target` is deleted. It stays as a tombstone so others can still insert after it. */
  | { readonly type: "delete"; readonly target: Stamp };

interface Node {
  readonly id: Stamp;
  readonly char: string;
  deleted: boolean;
}

/**
 * A replicated growable array (Roh et al., 2011), holding text. Every
 * character ever typed is kept, in one list that all replicas agree on;
 * the text is the ones not deleted.
 *
 * The rule that makes replicas agree: a character goes right after the
 * one it was typed after, but *after* any characters already there with a
 * bigger stamp. Those were typed concurrently, or after it, and win the
 * spot nearer the anchor. Since a Lamport stamp is bigger than everything
 * its peer had seen, anything inserted into a run is also bigger than the
 * run's start, so skipping bigger stamps skips whole runs and never splits
 * one.
 *
 * Ops must arrive after the characters they name. `apply` holds back an
 * op that comes too early and applies it once they turn up, so the
 * network may deliver in any order, and more than once.
 */
export class Rga {
  private readonly nodes: Node[] = [];
  private readonly index = new Map<string, Node>();
  private readonly waiting: RgaOp[] = [];
  private readonly clock: LamportClock;

  constructor(readonly peer: string) {
    this.clock = new LamportClock(peer);
  }

  /** Types `char` so it ends up at `position` in the text. */
  insert(position: number, char: string): RgaOp {
    const after = position === 0 ? null : this.visible(position - 1).id;
    const op: RgaOp = { type: "insert", id: this.clock.tick(), after, char };
    this.apply(op);
    return op;
  }

  /** Deletes the character at `position` in the text. */
  delete(position: number): RgaOp {
    const op: RgaOp = { type: "delete", target: this.visible(position).id };
    this.apply(op);
    return op;
  }

  /** Takes in an op from any replica, in any order, any number of times. */
  apply(op: RgaOp): void {
    if (!this.integrate(op)) {
      this.waiting.push(op);
      return;
    }
    // Something applied: ops waiting on it may be ready now.
    for (let progress = true; progress; ) {
      progress = false;
      for (let i = 0; i < this.waiting.length; i++) {
        if (this.integrate(this.waiting[i] as RgaOp)) {
          this.waiting.splice(i, 1);
          progress = true;
          i--;
        }
      }
    }
  }

  text(): string {
    return this.nodes
      .filter((n) => !n.deleted)
      .map((n) => n.char)
      .join("");
  }

  /** Characters kept, deleted ones included: what the text costs to store. */
  get size(): number {
    return this.nodes.length;
  }

  /** Ops held back until the characters they name arrive. */
  get pending(): number {
    return this.waiting.length;
  }

  /** Applies `op` if what it names is here. False means "not yet". */
  private integrate(op: RgaOp): boolean {
    if (op.type === "delete") {
      const node = this.index.get(key(op.target));
      if (!node) return false;
      node.deleted = true;
      return true;
    }
    // Seen it already: applying twice is the same as once.
    if (this.index.has(key(op.id))) return true;
    let at = 0;
    if (op.after !== null) {
      const anchor = this.index.get(key(op.after));
      if (!anchor) return false;
      at = this.nodes.indexOf(anchor) + 1;
    }
    while (at < this.nodes.length && compare((this.nodes[at] as Node).id, op.id) > 0) at++;
    const node: Node = { id: op.id, char: op.char, deleted: false };
    this.nodes.splice(at, 0, node);
    this.index.set(key(op.id), node);
    this.clock.observe(op.id);
    return true;
  }

  private visible(position: number): Node {
    let seen = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (seen === position) return node;
      seen++;
    }
    throw new RangeError(`no character at ${position}`);
  }
}
