import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { SCHEMA_VERSION, type Shape, type ShapeId } from "./shape";
import type { Origin, ShapeChange } from "./store";
import { createYDocStore } from "./yjs";

const id = (s: string) => s as ShapeId;

const rect = (shapeId: string, patch: Partial<Shape> = {}): Shape => ({
  id: id(shapeId),
  type: "rectangle",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  parentId: null,
  index: "a0",
  color: "blue",
  ...patch,
});

/** Two peers whose docs exchange updates as soon as they happen. */
function peers() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "net") Y.applyUpdate(b, update, "net");
  });
  b.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "net") Y.applyUpdate(a, update, "net");
  });
  return {
    a: createYDocStore(a, { captureTimeout: 0 }),
    b: createYDocStore(b, { captureTimeout: 0 }),
  };
}

/** Two peers that only sync when `sync()` is called, to model concurrency. */
function offlinePeers() {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)), "net");
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)), "net");
  };
  return {
    a: createYDocStore(docA, { captureTimeout: 0 }),
    b: createYDocStore(docB, { captureTimeout: 0 }),
    sync,
  };
}

function record(store: ReturnType<typeof createYDocStore>) {
  const log: Array<{ changes: readonly ShapeChange[]; origin: Origin }> = [];
  store.subscribe((changes, origin) => log.push({ changes, origin }));
  return log;
}

describe("YDocStore", () => {
  it("reports adds, updates and removes with the right origin on both peers", () => {
    const { a, b } = peers();
    const logA = record(a);
    const logB = record(b);

    a.transact((tx) => tx.add(rect("s1")));
    a.transact((tx) => tx.update(id("s1"), { x: 50 }));
    a.transact((tx) => tx.remove(id("s1")));

    const kinds = (log: typeof logA) => log.map((e) => [e.changes.map((c) => c.kind), e.origin]);
    expect(kinds(logA)).toEqual([
      [["added"], "local"],
      [["updated"], "local"],
      [["removed"], "local"],
    ]);
    expect(kinds(logB)).toEqual([
      [["added"], "remote"],
      [["updated"], "remote"],
      [["removed"], "remote"],
    ]);
    expect(logB[1]?.changes[0]).toMatchObject({ shape: { x: 50 }, previous: { x: 0 } });
  });

  it("batches a transaction into one notification", () => {
    const { a } = peers();
    const log = record(a);
    a.transact((tx) => {
      tx.add(rect("s1"));
      tx.add(rect("s2"));
      tx.update(id("s1"), { y: 5 });
    });
    expect(log).toHaveLength(1);
    expect(log[0]?.changes.map((c) => c.kind)).toEqual(["added", "added"]);
    expect(a.get(id("s1"))?.y).toBe(5);
  });

  it("writes nothing when an update doesn't change a value", () => {
    const { a } = peers();
    a.transact((tx) => tx.add(rect("s1")));
    const log = record(a);
    a.transact((tx) => tx.update(id("s1"), { x: 0, color: "blue" }));
    expect(log).toHaveLength(0);
    expect(a.canUndo()).toBe(true); // only the add
    a.undo();
    expect(a.get(id("s1"))).toBeUndefined();
  });

  it("keeps concurrent edits to different fields of one shape", () => {
    const { a, b, sync } = offlinePeers();
    a.transact((tx) => tx.add(rect("s1")));
    sync();
    a.transact((tx) => tx.update(id("s1"), { x: 300 }));
    b.transact((tx) => tx.update(id("s1"), { color: "red" }));
    sync();
    expect(a.get(id("s1"))).toMatchObject({ x: 300, color: "red" });
    expect(b.get(id("s1"))).toEqual(a.get(id("s1")));
  });

  it("undoes only local changes and never reverts a collaborator's", () => {
    const { a, b, sync } = offlinePeers();
    a.transact((tx) => tx.add(rect("s1")));
    sync();
    a.checkpoint();
    a.transact((tx) => tx.update(id("s1"), { x: 10 }));
    b.transact((tx) => tx.add(rect("s2")));
    sync();

    a.undo();
    expect(a.get(id("s1"))?.x).toBe(0);
    expect(a.get(id("s2"))).toBeDefined();
    a.redo();
    expect(a.get(id("s1"))?.x).toBe(10);
  });

  it("does not undo over a collaborator's later change to the same field", () => {
    const { a, b, sync } = offlinePeers();
    // b creates the shape, so a's only undo step is its own move.
    b.transact((tx) => tx.add(rect("s1")));
    sync();
    a.checkpoint();
    a.transact((tx) => tx.update(id("s1"), { x: 10 }));
    sync();
    b.transact((tx) => tx.update(id("s1"), { x: 99 }));
    sync();

    // a's move was overwritten, so undoing it changes nothing. (Yjs then
    // moves on to the next step in a's history; here there is none.)
    a.undo();
    sync();
    expect(a.get(id("s1"))?.x).toBe(99);
    expect(b.get(id("s1"))?.x).toBe(99);
  });

  it("merges a drag into one undo step and splits steps at checkpoints", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc, { captureTimeout: 60_000 });
    store.transact((tx) => tx.add(rect("s1")));
    store.checkpoint();
    for (let x = 1; x <= 20; x++) store.transact((tx) => tx.update(id("s1"), { x }));
    store.undo();
    expect(store.get(id("s1"))?.x).toBe(0);
    store.undo();
    expect(store.get(id("s1"))).toBeUndefined();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
  });

  it("reports canUndo correctly from inside a change listener", () => {
    const store = createYDocStore(new Y.Doc());
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.canUndo()));
    store.transact((tx) => tx.add(rect("s1")));
    store.undo();
    expect(seen).toEqual([true, false]);
  });

  it("hides shapes of unknown types but keeps them in the document", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    const alien = new Y.Map<unknown>([["type", "hologram"]]);
    doc.getMap("shapes").set("x1", alien);
    expect(store.get(id("x1"))).toBeUndefined();
    expect([...store.all()]).toHaveLength(0);
    expect(doc.getMap("shapes").has("x1")).toBe(true);
  });

  it("stamps a new board with the schema version on its first edit, not on open", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    expect(doc.getMap("meta").has("schemaVersion")).toBe(false);
    expect(store.readOnly).toBe(false);
    store.transact((tx) => tx.add(rect("s1")));
    expect(doc.getMap("meta").get("schemaVersion")).toBe(SCHEMA_VERSION);
    store.undo();
    // Undo removes the shape but not the version.
    expect(doc.getMap("meta").get("schemaVersion")).toBe(SCHEMA_VERSION);
  });

  it("an empty client that then receives a newer board becomes read-only, having written nothing", () => {
    const newer = new Y.Doc();
    newer.getMap("meta").set("schemaVersion", SCHEMA_VERSION + 1);
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(newer));
    expect(store.readOnly).toBe(true);
    expect(Y.decodeStateVector(Y.encodeStateVector(doc)).has(doc.clientID)).toBe(false);
  });

  it("a view-only store ignores edits and writes nothing", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc, { readOnly: true });
    store.transact((tx) => tx.add(rect("s1")));
    expect(store.readOnly).toBe(true);
    expect(store.get(id("s1"))).toBeUndefined();
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(new Y.Doc()));
  });

  it("opens a board from a newer version read-only and leaves it untouched", () => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("schemaVersion", SCHEMA_VERSION + 1);
    const store = createYDocStore(doc);
    const before = Y.encodeStateAsUpdate(doc);
    store.transact((tx) => tx.add(rect("s1")));
    expect(store.readOnly).toBe(true);
    expect(store.get(id("s1"))).toBeUndefined();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("loads shapes that were already in the doc", () => {
    const original = new Y.Doc();
    createYDocStore(original).transact((tx) => tx.add(rect("s1", { x: 7 })));
    // Rebuild from an encoded copy, as IndexedDB or the server would.
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(original));
    expect(createYDocStore(copy).get(id("s1"))).toEqual(rect("s1", { x: 7 }));
  });
});
