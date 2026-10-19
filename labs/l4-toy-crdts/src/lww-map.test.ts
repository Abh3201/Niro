import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LamportClock, WallClock } from "./clock";
import { type Entry, LwwMap } from "./lww-map";
import { Mailbag, steps } from "./net";

const PEERS = ["a", "b", "c"];

const edit = fc.record({
  key: fc.constantFrom("x", "y", "z"),
  // null stands for "delete the key".
  value: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
});

/** A map with these writes from these peers, applied in this order. */
function mapOf(entries: readonly Entry<number>[]) {
  const map = LwwMap.lamport<number>("reader");
  for (const entry of entries) map.apply(entry);
  return map;
}

/**
 * Three replicas' worth of writes: one history of writes from three peers
 * (some concurrent, some not), each write held by any of the replicas.
 * Taken from one history because a stamp names one write: two different
 * writes with the same stamp can't happen, and would break the merge.
 */
const replicas = fc
  .array(
    fc.record({
      peer: fc.integer({ min: 0, max: 2 }),
      edit,
      // Bit i set: replica i holds this write.
      holders: fc.integer({ min: 0, max: 7 }),
    }),
    { maxLength: 30 },
  )
  .map((list) => {
    const peers = PEERS.map((p) => LwwMap.lamport<number>(p));
    const held = list.map(({ peer, edit: { key, value }, holders }) => {
      const map = peers[peer] as LwwMap<number>;
      return { entry: value === null ? map.delete(key) : map.set(key, value), holders };
    });
    return [0, 1, 2].map((i) =>
      mapOf(held.filter((w) => w.holders & (1 << i)).map((w) => w.entry)),
    ) as [LwwMap<number>, LwwMap<number>, LwwMap<number>];
  });

describe("L4 last-writer-wins map", () => {
  it("lets the later write win, and keeps a delete from being undone by an older write", () => {
    const a = LwwMap.lamport<string>("a");
    const b = LwwMap.lamport<string>("b");
    const first = a.set("color", "red");
    b.apply(first);
    const second = b.set("color", "blue");
    const gone = b.delete("color");
    // a hears about them backwards.
    a.apply(gone);
    a.apply(second);
    expect(a.get("color")).toBeUndefined();
    expect(b.get("color")).toBeUndefined();
  });

  it("settles a tie between concurrent writes the same way everywhere", () => {
    const a = LwwMap.lamport<string>("a");
    const b = LwwMap.lamport<string>("b");
    const fromA = a.set("x", "a's");
    const fromB = b.set("x", "b's");
    // Same counter: the peer id decides, so both pick "b".
    expect(fromA.stamp.counter).toBe(fromB.stamp.counter);
    a.apply(fromB);
    b.apply(fromA);
    expect(a.get("x")).toBe("b's");
    expect(b.get("x")).toBe("b's");
  });

  it("loses a later edit to a clock that runs fast, which a Lamport clock doesn't", () => {
    const run = (clocks: "wall" | "lamport") => {
      // b's wall clock is five minutes fast.
      let now = 1_000_000;
      const make = (peer: string, skew: number) =>
        new LwwMap<string>(
          clocks === "wall" ? new WallClock(peer, () => now + skew) : new LamportClock(peer),
        );
      const a = make("a", 0);
      const b = make("b", 5 * 60_000);
      const bEdit = b.set("title", "Draft");
      a.apply(bEdit);
      // A minute later, a renames it, having seen b's edit.
      now += 60_000;
      const aEdit = a.set("title", "Final");
      b.apply(aEdit);
      return [a.get("title"), b.get("title")];
    };
    // Both agree, but on the older title: a's rename is lost.
    expect(run("wall")).toEqual(["Draft", "Draft"]);
    expect(run("lamport")).toEqual(["Final", "Final"]);
  });

  it("merges in any order, any grouping, any number of times (a join semilattice)", () => {
    fc.assert(
      fc.property(replicas, ([a, b, c]) => {
        const join = (...maps: LwwMap<number>[]) => mapOf(maps.flatMap((m) => m.state()));
        // Commutative, associative, idempotent.
        expect(join(a, b).toObject()).toEqual(join(b, a).toObject());
        expect(join(join(a, b), c).toObject()).toEqual(join(a, join(b, c)).toObject());
        expect(join(a, a).toObject()).toEqual(a.toObject());
      }),
    );
  });

  it("converges whatever the network does to the ops", () => {
    fc.assert(
      fc.property(steps(PEERS.length, edit), ({ steps: run, order }) => {
        const maps = PEERS.map((p) => LwwMap.lamport<number>(p));
        const net = new Mailbag<Entry<number>>(PEERS.length);
        for (const step of run) {
          const map = maps[step.peer] as LwwMap<number>;
          if (step.kind === "deliver") {
            net.deliver(step.peer, step.pick, step.twice, (e) => map.apply(e));
            continue;
          }
          const { key, value } = step.edit;
          net.send(step.peer, value === null ? map.delete(key) : map.set(key, value));
        }
        net.flush(order, (to, e) => maps[to]?.apply(e));
        const [first, ...rest] = maps.map((m) => m.toObject());
        for (const other of rest) expect(other).toEqual(first);
      }),
      { numRuns: 500 },
    );
  });
});
