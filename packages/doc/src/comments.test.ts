import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createCommentStore, MAX_COMMENT_LENGTH } from "./comments";

const alice = {
  userId: "alice-0123456789",
  name: "Alice",
  color: "#ef4444",
  text: "Is this right?",
};
const bob = { userId: "bob-012345678901", name: "Bob", color: "#3b82f6", text: "Looks fine" };

function peers() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array, o: unknown) => o !== "net" && Y.applyUpdate(b, u, "net"));
  b.on("update", (u: Uint8Array, o: unknown) => o !== "net" && Y.applyUpdate(a, u, "net"));
  return { a: createCommentStore(a), b: createCommentStore(b), docA: a, docB: b };
}

describe("comments", () => {
  it("starts a thread that the other peer sees, with the pin on a shape", () => {
    const { a, b } = peers();
    const id = a.add({ x: 10, y: 20, shape: { id: "shape1", ox: 5, oy: 6 } }, alice);
    expect(id).not.toBeNull();
    const seen = b.threads();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      x: 10,
      y: 20,
      shape: "shape1",
      ox: 5,
      oy: 6,
      resolved: false,
    });
    expect(seen[0]?.messages.map((m) => [m.name, m.text])).toEqual([["Alice", "Is this right?"]]);
  });

  it("keeps both replies when two people answer at once", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = createCommentStore(docA);
    const id = a.add({ x: 0, y: 0 }, alice) as string;
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = createCommentStore(docB);
    a.reply(id, { ...alice, text: "from a" });
    b.reply(id, bob);
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    for (const store of [a, b]) {
      expect(
        store
          .threads()[0]
          ?.messages.map((m) => m.text)
          .sort(),
      ).toEqual(["Looks fine", "Is this right?", "from a"].sort());
    }
  });

  it("resolves, reopens and deletes a thread", () => {
    const { a, b } = peers();
    const id = a.add({ x: 0, y: 0 }, alice) as string;
    b.setResolved(id, true);
    expect(a.threads()[0]?.resolved).toBe(true);
    a.setResolved(id, false);
    expect(b.threads()[0]?.resolved).toBe(false);
    b.remove(id);
    expect(a.threads()).toEqual([]);
  });

  it("tells subscribers about changes, and keeps the same array otherwise", () => {
    const { a } = peers();
    let calls = 0;
    a.subscribe(() => calls++);
    const empty = a.threads();
    expect(a.threads()).toBe(empty);
    a.add({ x: 0, y: 0 }, alice);
    expect(calls).toBeGreaterThan(0);
    expect(a.threads()).not.toBe(empty);
  });

  it("refuses empty text, bad ids and writes while read-only", () => {
    const { a } = peers();
    expect(a.add({ x: 0, y: 0 }, { ...alice, text: "   " })).toBeNull();
    expect(a.add({ x: 0, y: 0 }, { ...alice, userId: "x" })).toBeNull();
    expect(a.add({ x: Number.NaN, y: 0 }, alice)).toBeNull();
    a.setReadOnly(true);
    expect(a.add({ x: 0, y: 0 }, alice)).toBeNull();
    a.setReadOnly(false);
    const id = a.add({ x: 0, y: 0 }, alice) as string;
    a.setReadOnly(true);
    expect(a.reply(id, bob)).toBe(false);
    a.setResolved(id, true);
    a.remove(id);
    expect(a.threads()).toHaveLength(1);
    expect(a.threads()[0]?.resolved).toBe(false);
  });

  it("cuts long text and ignores what a peer wrote that isn't a comment", () => {
    const doc = new Y.Doc();
    const store = createCommentStore(doc);
    store.add({ x: 0, y: 0 }, { ...alice, text: "x".repeat(MAX_COMMENT_LENGTH + 50) });
    expect(store.threads()[0]?.messages[0]?.text).toHaveLength(MAX_COMMENT_LENGTH);
    const comments = doc.getMap<unknown>("comments");
    comments.set("junk", "not a map");
    const empty = new Y.Map<unknown>();
    empty.set("x", 1);
    empty.set("y", 1);
    const messages = new Y.Array<unknown>();
    messages.push([{ id: "m", userId: "bad", text: 5 }, 7, null]);
    empty.set("messages", messages);
    comments.set("t1", empty);
    expect(store.threads()).toHaveLength(1);
  });
});
