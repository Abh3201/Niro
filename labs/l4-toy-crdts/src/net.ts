import fc from "fast-check";

/**
 * A network as unkind as a CRDT is meant to survive: every op is sent to
 * every other peer, and arrives whenever the test says, in any order,
 * possibly twice. There's no loss here only because "lost" and "not
 * delivered yet" look the same until the end, when everything is
 * delivered.
 */
export class Mailbag<Op> {
  private readonly inboxes: Op[][];

  constructor(peers: number) {
    this.inboxes = Array.from({ length: peers }, () => []);
  }

  send(from: number, op: Op): void {
    this.inboxes.forEach((inbox, to) => {
      if (to !== from) inbox.push(op);
    });
  }

  /** Hands peer `to` one waiting op, picked by `pick`. With `twice`, the op stays to arrive again. */
  deliver(to: number, pick: number, twice: boolean, apply: (op: Op) => void): void {
    const inbox = this.inboxes[to] as Op[];
    if (inbox.length === 0) return;
    const at = pick % inbox.length;
    const op = inbox[at] as Op;
    if (!twice) inbox.splice(at, 1);
    apply(op);
  }

  /** Delivers everything left, in an order picked by `order`. */
  flush(order: readonly number[], apply: (to: number, op: Op) => void): void {
    this.inboxes.forEach((inbox, to) => {
      let i = 0;
      while (inbox.length > 0) {
        const at = (order[i++ % Math.max(1, order.length)] ?? 0) % inbox.length;
        apply(to, inbox.splice(at, 1)[0] as Op);
      }
    });
  }
}

/** One step of a run: a peer edits, or an op reaches a peer. */
export type Step<Edit> =
  | { readonly kind: "edit"; readonly peer: number; readonly edit: Edit }
  | {
      readonly kind: "deliver";
      readonly peer: number;
      readonly pick: number;
      readonly twice: boolean;
    };

export function steps<Edit>(peers: number, edit: fc.Arbitrary<Edit>, maxLength = 60) {
  const peer = fc.integer({ min: 0, max: peers - 1 });
  const step: fc.Arbitrary<Step<Edit>> = fc.oneof(
    fc.record({ kind: fc.constant("edit" as const), peer, edit }),
    fc.record({
      kind: fc.constant("deliver" as const),
      peer,
      pick: fc.nat(),
      twice: fc.boolean(),
    }),
  );
  return fc.record({
    steps: fc.array(step, { maxLength }),
    order: fc.array(fc.nat(), { minLength: 1, maxLength: 20 }),
  });
}
