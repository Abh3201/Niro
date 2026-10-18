import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Mailbag, steps } from "./net";
import { Rga, type RgaOp } from "./rga";

/** An edit as a fraction of the way through the text, so it fits whatever the text is by then. */
const edit = fc.record({
  insert: fc.boolean(),
  at: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
  char: fc.constantFrom(..."abcdefgh"),
});
type Edit = typeof edit extends fc.Arbitrary<infer E> ? E : never;

/** Makes `e` on `doc`; null if there's nothing to delete. */
function make(doc: Rga, e: Edit): RgaOp | null {
  const length = doc.text().length;
  if (e.insert) return doc.insert(Math.floor(e.at * (length + 1)), e.char);
  return length === 0 ? null : doc.delete(Math.floor(e.at * length));
}

/** Types `text` into `doc` at `position`, one character after another. */
function type(doc: Rga, position: number, text: string): RgaOp[] {
  return [...text].map((char, i) => doc.insert(position + i, char));
}

/** Two replicas of a doc holding `text`. */
function fork(text: string): [Rga, Rga] {
  const a = new Rga("a");
  const b = new Rga("b");
  for (const op of type(a, 0, text)) b.apply(op);
  return [a, b];
}

/** Hands each side the other's ops. */
function exchange(a: Rga, fromA: RgaOp[], b: Rga, fromB: RgaOp[]) {
  for (const op of fromB) a.apply(op);
  for (const op of fromA) b.apply(op);
}

/** Types `text` into `doc` at `position` backwards: last character first, each at the same spot. */
function typeBackwards(doc: Rga, position: number, text: string): RgaOp[] {
  return [...text].reverse().map((char) => doc.insert(position, char));
}

describe("L4 RGA text", () => {
  it("edits like a plain string when nobody is concurrent", () => {
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 80 }), (edits) => {
        const doc = new Rga("a");
        let model = "";
        for (const e of edits) {
          const length = model.length;
          if (e.insert) {
            const at = Math.floor(e.at * (length + 1));
            model = model.slice(0, at) + e.char + model.slice(at);
          } else if (length > 0) {
            const at = Math.floor(e.at * length);
            model = model.slice(0, at) + model.slice(at + 1);
          }
          make(doc, e);
          expect(doc.text()).toBe(model);
        }
      }),
    );
  });

  it("converges whatever the network does to the ops", () => {
    fc.assert(
      fc.property(steps(3, edit, 80), ({ steps: run, order }) => {
        const docs = ["a", "b", "c"].map((p) => new Rga(p));
        const net = new Mailbag<RgaOp>(docs.length);
        for (const step of run) {
          const doc = docs[step.peer] as Rga;
          if (step.kind === "deliver") {
            net.deliver(step.peer, step.pick, step.twice, (op) => doc.apply(op));
            continue;
          }
          const op = make(doc, step.edit);
          if (op) net.send(step.peer, op);
        }
        net.flush(order, (to, op) => docs[to]?.apply(op));
        const texts = docs.map((d) => d.text());
        for (const text of texts) expect(text).toBe(texts[0]);
        for (const doc of docs) expect(doc.pending).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it("holds back an op until what it names arrives", () => {
    const a = new Rga("a");
    const b = new Rga("b");
    const ops = type(a, 0, "hi");
    ops.push(a.delete(0));
    // b gets them last first.
    for (const op of ops.reverse()) b.apply(op);
    expect(b.text()).toBe("i");
    expect(b.pending).toBe(0);
  });

  it("keeps two words typed at the same spot whole", () => {
    const [a, b] = fork("[]");
    // Both type inside the brackets at once.
    exchange(a, type(a, 1, "cat"), b, type(b, 1, "dog"));
    // "d" and "c" both follow "[" with the same counter; b's peer id is
    // bigger, so "dog" takes the spot next to "[", and pushes "cat" right.
    expect(a.text()).toBe("[dogcat]");
    expect(b.text()).toBe("[dogcat]");
  });

  it("interleaves words typed backwards, a known weakness of RGA", () => {
    const [a, b] = fork("");
    exchange(a, typeBackwards(a, 0, "abc"), b, typeBackwards(b, 0, "xyz"));
    // Every character was typed at the start, so all six follow "the
    // start" and are ordered by stamp alone: the two words get shuffled.
    expect(a.text()).toBe("xaybzc");
    expect(b.text()).toBe("xaybzc");
  });

  it("keeps every deleted character, as a tombstone", () => {
    const doc = new Rga("a");
    type(doc, 0, "x".repeat(100));
    for (let i = 0; i < 100; i++) doc.delete(0);
    expect(doc.text()).toBe("");
    expect(doc.size).toBe(100);
  });
});

describe("L4 Yjs, for comparison", () => {
  /** Two Yjs docs that each type a word at `at` in `base`, then swap updates. */
  function yjs(base: string, at: number, fill: (t: Y.Text, at: number, word: string) => void) {
    const docs = [1, 2].map((client) => {
      const doc = new Y.Doc();
      doc.clientID = client;
      return doc;
    }) as [Y.Doc, Y.Doc];
    const [a, b] = docs;
    a.getText().insert(0, base);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    fill(a.getText(), at, "abc");
    fill(b.getText(), at, "xyz");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    return docs.map((d) => d.getText().toString());
  }
  const forwards = (t: Y.Text, at: number, word: string) =>
    [...word].forEach((char, i) => {
      t.insert(at + i, char);
    });
  const backwards = (t: Y.Text, at: number, word: string) => {
    for (const char of [...word].reverse()) t.insert(at, char);
  };

  it("keeps words whole whichever way they're typed", () => {
    // Yjs records what each character was typed *before* as well as after
    // (YATA's right origin), which keeps a backwards-typed word together.
    expect(yjs("", 0, backwards)).toEqual(["abcxyz", "abcxyz"]);
    expect(yjs("[]", 1, backwards)).toEqual(["[abcxyz]", "[abcxyz]"]);
    expect(yjs("[]", 1, forwards)).toEqual(["[abcxyz]", "[abcxyz]"]);
  });
});
