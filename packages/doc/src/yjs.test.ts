import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { SCHEMA_VERSION, type Shape, type ShapeId, type ShapePatch } from "./shape";
import type { Origin, ShapeChange } from "./store";
import { countShapes, createYDocStore } from "./yjs";

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
  text: "",
  points: [],
  from: null,
  to: null,
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
    docA: a,
    docB: b,
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

  it("restores a saved version as a new edit that collaborators receive and undo reverts", () => {
    const { a, b, docA } = peers();
    a.transact((tx) => {
      tx.add(rect("keep", { text: "hello world" }));
      tx.add(rect("gone", { x: 5 }));
    });
    const saved = Y.encodeStateAsUpdate(docA);
    a.checkpoint();
    a.transact((tx) => {
      tx.update(id("keep"), { x: 300, color: "red" });
      tx.editText(id("keep"), 5, 0, ",");
      tx.remove(id("gone"));
      tx.add(rect("new"));
    });
    b.transact((tx) => tx.update(id("keep"), { y: 77 }));
    a.checkpoint();

    expect(a.restore(saved)).toBe(true);
    for (const store of [a, b]) {
      expect([...store.all()].map((s) => s.id).sort()).toEqual(["gone", "keep"]);
      expect(store.get(id("keep"))).toMatchObject({
        x: 0,
        y: 0,
        color: "blue",
        text: "hello world",
      });
      expect(store.get(id("gone"))?.x).toBe(5);
    }
    // One step: undo puts back what was there before the restore.
    a.undo();
    expect([...a.all()].map((s) => s.id).sort()).toEqual(["keep", "new"]);
    expect(a.get(id("keep"))).toMatchObject({ x: 300, y: 77, text: "hello, world" });
  });

  it("restores nothing to a view-only store or from a newer version", () => {
    const { a, docA } = peers();
    a.transact((tx) => tx.add(rect("one")));
    const saved = Y.encodeStateAsUpdate(docA);
    a.transact((tx) => tx.add(rect("two")));
    const newer = new Y.Doc();
    newer.getMap("meta").set("schemaVersion", SCHEMA_VERSION + 1);
    expect(a.restore(Y.encodeStateAsUpdate(newer))).toBe(false);
    expect(a.restore(new Uint8Array([0xff, 0xff]))).toBe(false);
    expect([...a.all()]).toHaveLength(2);
    const doc = new Y.Doc();
    const viewer = createYDocStore(doc, { readOnly: true });
    expect(viewer.restore(saved)).toBe(false);
    expect([...viewer.all()]).toHaveLength(0);
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

  it("keeps a held step open across pauses, and ends it when released", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc, { captureTimeout: 2 });
    store.transact((tx) => tx.add(rect("s1")));
    const release = store.holdStep();
    store.transact((tx) => tx.update(id("s1"), { x: 50 }));
    // The pointer rests. (lib0 holds its own reference to Date.now, so fake timers can't stand in.)
    for (const until = Date.now() + 10; Date.now() < until; );
    store.transact((tx) => tx.update(id("s1"), { x: 100 }));
    release();
    store.transact((tx) => tx.update(id("s1"), { x: 150 }));
    store.undo();
    expect(store.get(id("s1"))?.x).toBe(100);
    store.undo();
    expect(store.get(id("s1"))?.x).toBe(0);
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

  it("upgrades an older board that arrives after the store was created, on the next edit", () => {
    const older = new Y.Doc();
    older.getMap("meta").set("schemaVersion", SCHEMA_VERSION - 1);
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(older));
    store.transact((tx) => tx.add(rect("s1")));
    expect(doc.getMap("meta").get("schemaVersion")).toBe(SCHEMA_VERSION);
    store.undo();
    expect(doc.getMap("meta").get("schemaVersion")).toBe(SCHEMA_VERSION);
  });

  it("opens a board with a version that isn't a whole number from 1 up read-only, without hanging", () => {
    for (const version of [-1e300, -1, 0, 2.5, Number.NaN]) {
      const doc = new Y.Doc();
      doc.getMap("meta").set("schemaVersion", version);
      const store = createYDocStore(doc);
      expect(store.readOnly).toBe(true);
      expect(doc.getMap("meta").get("schemaVersion")).toBe(version);
    }
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

  it("can be made read-only and editable again, and tells its listeners each time", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    const calls: number[] = [];
    store.subscribe((changes) => calls.push(changes.length));
    store.setReadOnly(true);
    store.setReadOnly(true);
    store.transact((tx) => tx.add(rect("s1")));
    expect(store.readOnly).toBe(true);
    expect(store.get(id("s1"))).toBeUndefined();

    store.setReadOnly(false);
    store.transact((tx) => tx.add(rect("s1")));
    expect(store.get(id("s1"))).toBeDefined();
    expect(calls).toEqual([0, 0, 1]);
  });

  it("keeps everyone's characters when two people type in one shape at once", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const storeA = createYDocStore(a);
    const storeB = createYDocStore(b);
    storeA.transact((tx) => tx.add(rect("s1", { type: "sticky", text: "hello" })));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Offline from each other: both type at the end, one also at the start.
    storeA.transact((tx) => tx.editText(id("s1"), 5, 0, " world"));
    storeB.transact((tx) => {
      tx.editText(id("s1"), 5, 0, "!!");
      tx.editText(id("s1"), 0, 0, ">");
    });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const text = storeA.get(id("s1"))?.text ?? "";
    expect(storeB.get(id("s1"))?.text).toBe(text);
    expect(text).toMatch(/^>hello( world!!|!! world)$/);
  });

  it("formats parts of a shape's text: synced, undone, and kept by copies and restores", () => {
    const { a, b, docA } = peers();
    const seen: Shape[] = [];
    b.subscribe((changes) => {
      for (const change of changes) if (change.kind === "updated") seen.push(change.shape);
    });
    a.transact((tx) => tx.add(rect("s1", { type: "sticky", text: "Title\nbody" })));
    a.checkpoint();
    a.transact((tx) => tx.formatText(id("s1"), 0, 6, { underline: true, size: 32 }));
    a.checkpoint();
    for (const store of [a, b])
      expect(store.get(id("s1"))?.textRuns).toEqual([
        { length: 6, marks: { underline: true, size: 32 } },
        { length: 4, marks: {} },
      ]);
    // A format alone is news to listeners, though no character changed.
    expect(seen.at(-1)?.textRuns?.[0]?.marks).toEqual({ underline: true, size: 32 });

    // Typed text takes the marks it's given, none it isn't.
    a.transact((tx) => tx.editText(id("s1"), 5, 0, "!", { underline: true, size: 32 }));
    a.transact((tx) => tx.editText(id("s1"), 11, 0, "?"));
    expect(b.get(id("s1"))?.textRuns).toEqual([
      { length: 7, marks: { underline: true, size: 32 } },
      { length: 5, marks: {} },
    ]);
    const saved = Y.encodeStateAsUpdate(docA);

    // Taking a mark away; then undo puts it back.
    a.checkpoint();
    a.transact((tx) => tx.formatText(id("s1"), 0, 7, { underline: null }));
    expect(a.get(id("s1"))?.textRuns?.[0]?.marks).toEqual({ size: 32 });
    a.undo();
    expect(a.get(id("s1"))?.textRuns?.[0]?.marks).toEqual({ underline: true, size: 32 });
    a.undo();
    a.undo();
    a.undo();
    expect(b.get(id("s1"))?.text).toBe("Title\nbody");
    expect(b.get(id("s1"))?.textRuns).toBeUndefined();

    // A restored version has its formatting.
    expect(a.restore(saved)).toBe(true);
    expect(b.get(id("s1"))?.textRuns?.[0]).toEqual({
      length: 7,
      marks: { underline: true, size: 32 },
    });

    // So does a copy.
    const copy = { ...(a.get(id("s1")) as Shape), id: id("s2") };
    a.transact((tx) => tx.add(copy));
    expect(b.get(id("s2"))?.textRuns).toEqual(a.get(id("s1"))?.textRuns);
  });

  it("formats only shapes that take formatting, and only with marks it knows", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    store.transact((tx) => {
      tx.add(rect("s1", { text: "abc" }));
      tx.add(rect("f1", { type: "frame", text: "abc" }));
    });
    store.transact((tx) => {
      tx.formatText(id("s1"), 0, 1, { bold: true });
      tx.formatText(id("f1"), 0, 1, { bold: true });
    });
    expect(store.get(id("s1"))?.textRuns).toEqual([
      { length: 1, marks: { bold: true } },
      { length: 2, marks: {} },
    ]);
    expect(store.get(id("f1"))?.textRuns).toBeUndefined();
    // Junk from another client is dropped, not drawn.
    const text = (doc.getMap("shapes").get("s1") as Y.Map<unknown>).get("text") as Y.Text;
    doc.transact(() => text.format(1, 1, { size: "huge", font: "comic", bold: "yes" }));
    expect(store.get(id("s1"))?.textRuns).toEqual([
      { length: 1, marks: { bold: true } },
      { length: 2, marks: {} },
    ]);
  });

  it("edits text by position, clamping positions past the end", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    store.transact((tx) => tx.add(rect("s1", { text: "abcdef" })));
    store.transact((tx) => tx.editText(id("s1"), 1, 2, "XY"));
    expect(store.get(id("s1"))?.text).toBe("aXYdef");
    store.transact((tx) => tx.editText(id("s1"), 99, 5, "!"));
    expect(store.get(id("s1"))?.text).toBe("aXYdef!");
    store.transact((tx) => tx.editText(id("s1"), -3, 1, ""));
    expect(store.get(id("s1"))?.text).toBe("XYdef!");
  });

  it("tells listeners about text edits, and undoes typing in steps", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc, { captureTimeout: 10_000 });
    store.transact((tx) => tx.add(rect("s1", { type: "sticky" })));
    store.checkpoint();
    const texts: string[] = [];
    store.subscribe((changes) => {
      for (const change of changes) if (change.kind === "updated") texts.push(change.shape.text);
    });
    for (const char of "hi") store.transact((tx) => tx.editText(id("s1"), 9, 0, char));
    expect(texts).toEqual(["h", "hi"]);

    store.undo();
    expect(store.get(id("s1"))?.text).toBe("");
    expect(store.get(id("s1"))).toBeDefined();
  });

  it("says exactly where text changed, local or remote", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const storeA = createYDocStore(a);
    const storeB = createYDocStore(b);
    storeA.transact((tx) => tx.add(rect("s1", { type: "sticky", text: "aa" })));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const seen: ShapeChange[] = [];
    storeA.subscribe((changes) => seen.push(...changes));
    // B adds an "a" at the start; A can't tell that from the text alone.
    storeB.transact((tx) => tx.editText(id("s1"), 0, 0, "a"));
    storeB.transact((tx) => tx.editText(id("s1"), 1, 2, "b"));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    expect(seen).toHaveLength(1);
    const change = seen[0];
    if (change?.kind !== "updated") throw new Error("expected an update");
    expect(change.previous.text).toBe("aa");
    expect(change.shape.text).toBe("ab");
    // One remote update holding both edits, in order: insert "a" at 0, then
    // replace the last two characters with "b".
    let text = change.previous.text;
    for (const edit of change.textEdits ?? []) {
      text = text.slice(0, edit.index) + edit.insert + text.slice(edit.index + edit.deleteCount);
    }
    expect(text).toBe("ab");
    expect(change.textEdits?.[0]).toMatchObject({ index: 0 });
  });

  it("never lets an update replace a shape's text", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    store.transact((tx) => tx.add(rect("s1", { type: "sticky", text: "kept" })));
    // A whole shape used as a patch, as restoring a cancelled drag might.
    const patch = { ...rect("s1", { x: 5 }), text: "lost" } as unknown as ShapePatch;
    store.transact((tx) => tx.update(id("s1"), patch));
    expect(store.get(id("s1"))).toMatchObject({ x: 5, text: "kept" });
    expect(doc.getMap<Y.Map<unknown>>("shapes").get("s1")?.get("text")).toBeInstanceOf(Y.Text);
  });

  it("stores no text on lines", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    store.transact((tx) => tx.add(rect("l1", { type: "line", text: "nope" })));
    store.transact((tx) => tx.editText(id("l1"), 0, 0, "still no"));
    expect(store.get(id("l1"))?.text).toBe("");
    expect(doc.getMap<Y.Map<unknown>>("shapes").get("l1")?.has("text")).toBe(false);
  });

  it("stores a stroke's points and an arrow's ends only on shapes that have them", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    const stroke = rect("f1", { type: "freehand", points: [0, 0, 50, 10_000, 10_000, 50] });
    const arrow = rect("a1", { type: "arrow", from: id("s1"), to: null });
    store.transact((tx) => {
      tx.add(rect("s1"));
      tx.add(stroke);
      tx.add(arrow);
    });
    const stored = doc.getMap<Y.Map<unknown>>("shapes");
    for (const key of ["points", "from", "to"]) expect(stored.get("s1")?.has(key)).toBe(false);
    expect(stored.get("a1")?.get("from")).toBe("s1");
    expect(stored.get("a1")?.has("to")).toBe(false);
    expect(store.get(id("f1"))).toEqual(stroke);
    expect(store.get(id("a1"))).toEqual(arrow);
  });

  it("never lets an update rewrite a stroke's points, but can attach and detach an arrow", () => {
    const store = createYDocStore(new Y.Doc());
    store.transact((tx) => {
      tx.add(rect("f1", { type: "freehand", points: [0, 0, 50] }));
      tx.add(rect("a1", { type: "arrow" }));
    });
    const patch = { x: 5, points: [1, 1, 1] } as unknown as ShapePatch;
    store.transact((tx) => tx.update(id("f1"), patch));
    expect(store.get(id("f1"))).toMatchObject({ x: 5, points: [0, 0, 50] });

    store.transact((tx) => tx.update(id("a1"), { from: id("f1") }));
    expect(store.get(id("a1"))?.from).toBe("f1");
    store.transact((tx) => tx.update(id("a1"), { from: null }));
    expect(store.get(id("a1"))?.from).toBeNull();
  });

  it("opens a board from a newer version read-only, whatever this version is", () => {
    expect(SCHEMA_VERSION).toBe(10);
    const doc = new Y.Doc();
    doc.getMap("meta").set("schemaVersion", SCHEMA_VERSION + 1);
    expect(createYDocStore(doc).readOnly).toBe(true);
  });

  it("upgrades a board from before text to the current version, so older Niros stop editing it", () => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("schemaVersion", 1);
    const store = createYDocStore(doc);
    expect(doc.getMap("meta").get("schemaVersion")).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThan(1);
    expect(store.readOnly).toBe(false);
  });

  it("gives a shape from before text existed its text on the first edit", () => {
    const doc = new Y.Doc();
    const old = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(rect("s1")))
      if (key !== "id" && key !== "text") old.set(key, value);
    doc.getMap("shapes").set("s1", old);
    const store = createYDocStore(doc);
    store.transact((tx) => tx.editText(id("s1"), 0, 0, "new"));
    expect(store.get(id("s1"))?.text).toBe("new");
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

describe("countShapes", () => {
  it("follows adds and removes, local or remote, in any batch", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    store.transact((tx) => tx.add(rect("s1")));
    const counter = countShapes(doc);
    expect(counter.count).toBe(1);

    store.transact((tx) => {
      tx.add(rect("s2"));
      tx.add(rect("s3"));
      tx.update(id("s1"), { x: 5 });
    });
    expect(counter.count).toBe(3);

    // Added and removed in one batch: never counted.
    store.transact((tx) => {
      tx.add(rect("s4"));
      tx.remove(id("s4"));
      tx.remove(id("s2"));
    });
    expect(counter.count).toBe(2);

    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    createYDocStore(other).transact((tx) => tx.add(rect("s5")));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(counter.count).toBe(3);
    expect(counter.count).toBe(doc.getMap("shapes").size);

    counter.destroy();
    store.transact((tx) => tx.add(rect("s6")));
    expect(counter.count).toBe(3);
  });

  it("keeps everyone's reactions when people react to one shape at once", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = createYDocStore(docA);
    const b = createYDocStore(docB);
    a.transact((tx) => tx.add(rect("r")));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    // Offline at the same time: each reacts, and one takes back a reaction it never gave.
    a.transact((tx) => tx.react(id("r"), "like", "userAAAAAAAA", true));
    b.transact((tx) => {
      tx.react(id("r"), "like", "userBBBBBBBB", true);
      tx.react(id("r"), "party", "userBBBBBBBB", true);
      tx.react(id("r"), "like", "userAAAAAAAA", false);
    });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const expected = { like: ["userAAAAAAAA", "userBBBBBBBB"], party: ["userBBBBBBBB"] };
    expect(a.get(id("r"))?.reactions).toEqual(expected);
    expect(b.get(id("r"))?.reactions).toEqual(expected);

    a.transact((tx) => tx.react(id("r"), "like", "userAAAAAAAA", false));
    expect(a.get(id("r"))?.reactions).toEqual({
      like: ["userBBBBBBBB"],
      party: ["userBBBBBBBB"],
    });
  });

  it("ignores reactions that aren't on the list or have bad ids, and copies start without any", () => {
    const doc = new Y.Doc();
    const store = createYDocStore(doc);
    store.transact((tx) => {
      tx.add(rect("r"));
      tx.react(id("r"), "like", "short", true);
      tx.react(id("r"), "nope" as "like", "userAAAAAAAA", true);
    });
    const map = doc.getMap<Y.Map<unknown>>("shapes").get("r");
    map?.set("reaction.like.has spaces!", true);
    map?.set("reaction.boo.userAAAAAAAA", true);
    expect(store.get(id("r"))?.reactions).toBeUndefined();
    store.transact((tx) => tx.react(id("r"), "wow", "userAAAAAAAA", true));
    const reacted = store.get(id("r")) as Shape;
    store.transact((tx) => tx.add({ ...reacted, id: id("copy") }));
    expect(store.get(id("copy"))?.reactions).toBeUndefined();
  });

  it("stores an image's file id, and only a well-formed one", () => {
    const store = createYDocStore(new Y.Doc());
    const asset = "a".repeat(64);
    store.transact((tx) => {
      tx.add(rect("i", { type: "image", asset }));
      tx.add(rect("bad", { type: "image", asset: "../etc/passwd" }));
      tx.add(rect("r", { asset }));
    });
    expect(store.get(id("i"))?.asset).toBe(asset);
    expect(store.get(id("bad"))?.asset).toBe("");
    expect(store.get(id("r"))?.asset).toBeUndefined();
  });
});
