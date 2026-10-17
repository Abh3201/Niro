/**
 * Lab L6: the behaviors Niro's document model depends on, checked on both
 * Yjs and Loro. Each test states what we need and asserts what the library
 * actually does, so the decision record (docs/decisions/0001-sync-library.md)
 * rests on reproducible facts rather than on blog posts.
 */
import { LoroDoc, type LoroMap, UndoManager as LoroUndoManager, type TreeID } from "loro-crdt";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/** Sends every update each Yjs doc has that the other lacks. */
function syncY(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "remote");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), "remote");
}

/** Sends every update each Loro doc has that the other lacks. */
function syncLoro(a: LoroDoc, b: LoroDoc): void {
  b.import(a.export({ mode: "update", from: b.oplogVersion() }));
  a.import(b.export({ mode: "update", from: a.oplogVersion() }));
}

function yPair(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  a.clientID = 1;
  const b = new Y.Doc();
  b.clientID = 2;
  return [a, b];
}

function loroPair(): [LoroDoc, LoroDoc] {
  const a = new LoroDoc();
  a.setPeerId(1n);
  const b = new LoroDoc();
  b.setPeerId(2n);
  return [a, b];
}

/** Follows parentId links; true when a shape is its own ancestor. */
function hasCycle(parents: Map<string, string | null>): boolean {
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    let at: string | null | undefined = start;
    while (at != null) {
      if (seen.has(at)) return true;
      seen.add(at);
      at = parents.get(at);
    }
  }
  return false;
}

describe("concurrent reparenting (groups and frames)", () => {
  it("Yjs: a parentId field converges to a cycle that the app must repair", () => {
    const [a, b] = yPair();
    const shapes = a.getMap<Y.Map<unknown>>("shapes");
    a.transact(() => {
      for (const id of ["A", "B"]) {
        const shape = new Y.Map<unknown>();
        shape.set("parentId", null);
        shapes.set(id, shape);
      }
    });
    syncY(a, b);

    // Peer a puts A inside B while peer b puts B inside A.
    a.getMap<Y.Map<unknown>>("shapes").get("A")?.set("parentId", "B");
    b.getMap<Y.Map<unknown>>("shapes").get("B")?.set("parentId", "A");
    syncY(a, b);

    const parentsOf = (doc: Y.Doc) =>
      new Map(
        [...doc.getMap<Y.Map<unknown>>("shapes").entries()].map(([id, s]) => [
          id,
          s.get("parentId") as string | null,
        ]),
      );
    expect(parentsOf(a)).toEqual(parentsOf(b));
    expect(hasCycle(parentsOf(a))).toBe(true);
  });

  it("Loro: the movable tree drops the move that would create a cycle", () => {
    const [a, b] = loroPair();
    const treeA = a.getTree("shapes");
    const nodeA = treeA.createNode();
    const nodeB = treeA.createNode();
    a.commit();
    syncLoro(a, b);

    treeA.move(nodeA.id, nodeB.id);
    a.commit();
    b.getTree("shapes").move(nodeB.id, nodeA.id);
    b.commit();
    syncLoro(a, b);

    const parentsOf = (doc: LoroDoc) =>
      new Map<string, string | null>(
        doc
          .getTree("shapes")
          .nodes()
          .map((n) => [n.id, n.parent()?.id ?? null]),
      );
    expect(parentsOf(a)).toEqual(parentsOf(b));
    expect(hasCycle(parentsOf(a))).toBe(false);
    // Exactly one of the two moves survived.
    const survivors = [...parentsOf(a).values()].filter((p) => p !== null);
    expect(survivors).toHaveLength(1);
  });
});

describe("concurrent edits to different properties of one shape", () => {
  it("Yjs: a nested Y.Map per shape keeps both edits", () => {
    const [a, b] = yPair();
    const shape = new Y.Map<unknown>();
    a.getMap<Y.Map<unknown>>("shapes").set("s1", shape);
    shape.set("x", 0);
    shape.set("color", "blue");
    syncY(a, b);

    a.getMap<Y.Map<unknown>>("shapes").get("s1")?.set("x", 100);
    b.getMap<Y.Map<unknown>>("shapes").get("s1")?.set("color", "red");
    syncY(a, b);

    const s = a.getMap<Y.Map<unknown>>("shapes").get("s1")?.toJSON();
    expect(s).toEqual({ x: 100, color: "red" });
    expect(b.getMap<Y.Map<unknown>>("shapes").get("s1")?.toJSON()).toEqual(s);
  });

  it("Loro: a LoroMap container per shape keeps both edits", () => {
    const [a, b] = loroPair();
    const tree = a.getTree("shapes");
    const node = tree.createNode();
    node.data.set("x", 0);
    node.data.set("color", "blue");
    a.commit();
    syncLoro(a, b);

    a.getTree("shapes").getNodeByID(node.id)?.data.set("x", 100);
    a.commit();
    b.getTree("shapes").getNodeByID(node.id)?.data.set("color", "red");
    b.commit();
    syncLoro(a, b);

    const dataOf = (doc: LoroDoc, id: TreeID) =>
      (doc.getTree("shapes").getNodeByID(id)?.data as LoroMap | undefined)?.toJSON();
    expect(dataOf(a, node.id)).toEqual({ x: 100, color: "red" });
    expect(dataOf(b, node.id)).toEqual(dataOf(a, node.id));
  });

  it("Yjs: the same property edited on both peers resolves to one value everywhere", () => {
    const [a, b] = yPair();
    a.getMap("shape").set("x", 0);
    syncY(a, b);
    a.getMap("shape").set("x", 10);
    b.getMap("shape").set("x", 20);
    syncY(a, b);
    expect(a.getMap("shape").get("x")).toBe(b.getMap("shape").get("x"));
  });
});

describe("undo only reverts the local user's own changes", () => {
  it("Yjs: UndoManager with trackedOrigins skips remote updates", () => {
    const [a, b] = yPair();
    const shape = a.getMap("shape");
    const undo = new Y.UndoManager(shape, {
      trackedOrigins: new Set(["local"]),
      captureTimeout: 0,
    });
    a.transact(() => shape.set("x", 1), "local");
    a.transact(() => shape.set("x", 2), "local");
    syncY(a, b);
    b.getMap("shape").set("y", 9);
    syncY(a, b);

    undo.undo();
    expect(shape.toJSON()).toEqual({ x: 1, y: 9 });
  });

  it("Loro: UndoManager only tracks the local peer's commits", () => {
    const [a, b] = loroPair();
    const undo = new LoroUndoManager(a, { mergeInterval: 0 });
    a.getMap("shape").set("x", 1);
    a.commit();
    a.getMap("shape").set("x", 2);
    a.commit();
    syncLoro(a, b);
    b.getMap("shape").set("y", 9);
    b.commit();
    syncLoro(a, b);

    undo.undo();
    expect(a.getMap("shape").toJSON()).toEqual({ x: 1, y: 9 });
  });
});

describe("z-order", () => {
  it("Loro: sibling order is a fractional index maintained by the tree", () => {
    const [a, b] = loroPair();
    const tree = a.getTree("shapes");
    tree.enableFractionalIndex(0);
    const first = tree.createNode();
    const second = tree.createNode();
    a.commit();
    syncLoro(a, b);

    // Both peers insert at index 1 concurrently: both shapes survive and
    // every peer agrees on one order.
    a.getTree("shapes").createNode(undefined, 1);
    a.commit();
    b.getTree("shapes").createNode(undefined, 1);
    b.commit();
    syncLoro(a, b);

    const order = (doc: LoroDoc) =>
      doc
        .getTree("shapes")
        .roots()
        .map((n) => n.id);
    expect(order(a)).toHaveLength(4);
    expect(order(a)).toEqual(order(b));
    expect(order(a)[0]).toBe(first.id);
    expect(order(a).at(-1)).toBe(second.id);
  });
});
