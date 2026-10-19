import fc from "fast-check";
import { generateNKeysBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";
import { compareOrder, isValidIndex, reorderStep, reorderToEnd } from "./order";

interface Item {
  id: string;
  index: string;
}

/** A sorted board of `n` shapes with distinct keys, ids s0..s(n-1). */
const board = (n: number): Item[] =>
  generateNKeysBetween(null, null, n).map((index, i) => ({ id: `s${i}`, index }));

const apply = (items: Item[], keys: Map<string, string>): Item[] =>
  items.map((s) => ({ ...s, index: keys.get(s.id) ?? s.index })).sort(compareOrder);

const ids = (items: Item[]) => items.map((s) => s.id);

/** Reference model: move each selected item one step past its unselected neighbor. */
function modelStep(order: string[], selected: Set<string>, direction: 1 | -1): string[] {
  const list = [...order];
  const start = direction === 1 ? list.length - 2 : 1;
  for (let i = start; i >= 0 && i < list.length; i -= direction) {
    const a = list[i] as string;
    const b = list[i + direction];
    if (b !== undefined && selected.has(a) && !selected.has(b)) {
      list[i] = b;
      list[i + direction] = a;
    }
  }
  return list;
}

const boardAndSelection = fc.integer({ min: 1, max: 30 }).chain((n) =>
  fc.tuple(
    fc.constant(board(n)),
    fc.subarray(
      board(n).map((s) => s.id),
      { minLength: 1 },
    ),
  ),
);

describe("compareOrder", () => {
  it("orders by key, then by id when keys tie", () => {
    const items = [
      { id: "b", index: "a1" },
      { id: "a", index: "a1" },
      { id: "z", index: "a0" },
    ];
    expect(ids([...items].sort(compareOrder))).toEqual(["z", "a", "b"]);
  });
});

describe("isValidIndex", () => {
  it("accepts generated keys and rejects junk", () => {
    expect(isValidIndex("a0")).toBe(true);
    expect(isValidIndex("a0V")).toBe(true);
    for (const junk of ["", "a", "zz", "A0", "x".repeat(300)])
      expect(isValidIndex(junk)).toBe(false);
  });
});

describe("reorderStep", () => {
  it.each([1, -1] as const)("matches the reference model (direction %i)", (direction) => {
    fc.assert(
      fc.property(boardAndSelection, ([items, picked]) => {
        const selected = new Set(picked);
        const result = apply(items, reorderStep(items, selected, direction));
        expect(ids(result)).toEqual(modelStep(ids(items), selected, direction));
      }),
    );
  });

  it("only rewrites the keys of shapes that moved", () => {
    const items = board(5);
    const keys = reorderStep(items, new Set(["s1"]), 1);
    expect([...keys.keys()]).toEqual(["s1"]);
  });

  it("still moves a shape past neighbors whose keys tie", () => {
    // s1 and s2 picked the same key concurrently; s0 moves up past s1.
    const items = [
      { id: "s0", index: "a0" },
      { id: "s1", index: "a1" },
      { id: "s2", index: "a1" },
      { id: "s3", index: "a2" },
    ];
    const result = apply(items, reorderStep(items, new Set(["s0"]), 1));
    const s0 = ids(result).indexOf("s0");
    expect(s0).toBeGreaterThan(ids(result).indexOf("s1"));
    expect(s0).toBeLessThan(ids(result).indexOf("s3"));
  });
});

describe("reorderToEnd", () => {
  it.each([1, -1] as const)(
    "moves the selection to one end, keeping its order (%i)",
    (direction) => {
      fc.assert(
        fc.property(boardAndSelection, ([items, picked]) => {
          const selected = new Set(picked);
          const result = ids(apply(items, reorderToEnd(items, selected, direction)));
          const inOrder = ids(items).filter((id) => selected.has(id));
          const rest = ids(items).filter((id) => !selected.has(id));
          expect(result).toEqual(direction === 1 ? [...rest, ...inOrder] : [...inOrder, ...rest]);
        }),
      );
    },
  );
});
