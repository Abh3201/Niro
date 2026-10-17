import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { effectiveParents } from "./tree";

interface Node {
  id: string;
  type: "group";
  parentId: string | null;
}

/** Any parent graph over up to 12 nodes, including cycles and dangling parents. */
const graphs = fc.integer({ min: 1, max: 12 }).chain((n) =>
  fc
    .array(fc.option(fc.integer({ min: 0, max: n + 1 }), { nil: null }), {
      minLength: n,
      maxLength: n,
    })
    .map((parents): Node[] =>
      parents.map((p, i) => ({
        id: `n${i}`,
        type: "group" as const,
        parentId: p === null ? null : `n${p}`,
      })),
    ),
);

function isAcyclic(parent: Map<string, string | null>): boolean {
  for (const start of parent.keys()) {
    let at = parent.get(start) ?? null;
    for (let steps = 0; at !== null; steps++) {
      if (steps > parent.size) return false;
      at = parent.get(at) ?? null;
    }
  }
  return true;
}

describe("effectiveParents", () => {
  it("breaks the two-shape cycle from concurrent reparenting at the smaller id", () => {
    const result = effectiveParents([
      { id: "A", type: "group", parentId: "B" },
      { id: "B", type: "frame", parentId: "A" },
    ]);
    expect(result).toEqual(
      new Map([
        ["A", null],
        ["B", "A"],
      ]),
    );
  });

  it("makes shapes with a missing parent top level", () => {
    expect(effectiveParents([{ id: "A", type: "group", parentId: "gone" }]).get("A")).toBeNull();
  });

  it("only lets groups and frames hold shapes", () => {
    const result = effectiveParents([
      { id: "box", type: "rectangle", parentId: null },
      { id: "in-box", type: "ellipse", parentId: "box" },
      { id: "frame", type: "frame", parentId: null },
      { id: "in-frame", type: "sticky", parentId: "frame" },
    ]);
    expect(result.get("in-box")).toBeNull();
    expect(result.get("in-frame")).toBe("frame");
  });

  it("always returns a forest", () => {
    fc.assert(
      fc.property(graphs, (nodes) => {
        expect(isAcyclic(effectiveParents(nodes))).toBe(true);
      }),
    );
  });

  it("gives every peer the same answer, whatever order it reads shapes in", () => {
    fc.assert(
      fc.property(
        graphs.chain((nodes) =>
          fc.tuple(fc.constant(nodes), fc.shuffledSubarray(nodes, { minLength: nodes.length })),
        ),
        ([nodes, shuffled]) => {
          expect(effectiveParents(shuffled)).toEqual(effectiveParents(nodes));
        },
      ),
    );
  });

  it("detaches exactly the smallest id of each cycle and nothing else", () => {
    fc.assert(
      fc.property(graphs, (nodes) => {
        const ids = new Set(nodes.map((n) => n.id));
        const declared = new Map(
          nodes.map((n) => [n.id, n.parentId !== null && ids.has(n.parentId) ? n.parentId : null]),
        );
        // Reference: a node is on a cycle when following parents leads back to it.
        const breakers = new Set<string>();
        for (const id of ids) {
          const cycle = [id];
          let at = declared.get(id) ?? null;
          while (at !== null && at !== id && cycle.length <= ids.size) {
            cycle.push(at);
            at = declared.get(at) ?? null;
          }
          if (at === id) breakers.add(cycle.reduce((a, b) => (b < a ? b : a)));
        }

        const result = effectiveParents(nodes);
        const changed = [...ids].filter((id) => result.get(id) !== declared.get(id));
        expect(new Set(changed)).toEqual(breakers);
        for (const id of changed) expect(result.get(id)).toBeNull();
      }),
    );
  });
});
