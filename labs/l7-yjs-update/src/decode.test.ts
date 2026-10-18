import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type Content, decodeUpdate, explain, type Id, type Struct, TYPE_NAMES } from "./decode";

/** Yjs's own reading of an update, in this lab's shapes, to compare with. */
function yjsReading(update: Uint8Array) {
  const { structs, ds } = Y.decodeUpdate(update);
  const deletes = [...ds.clients].flatMap(([client, items]) =>
    items.map((d) => ({ client, clock: d.clock, length: d.len })),
  );
  return { structs: structs.map(yjsStruct), deletes };
}

function yjsStruct(struct: Y.Item | Y.GC | Y.Skip): Struct {
  const id = asId(struct.id);
  if (struct instanceof Y.GC) return { kind: "gc", id, length: struct.length };
  if (struct instanceof Y.Skip) return { kind: "skip", id, length: struct.length };
  // Read straight from an update, `parent` is the root name or the parent item's id.
  const parent = struct.parent as unknown as string | Y.ID | null;
  return {
    kind: "item",
    id,
    length: struct.length,
    origin: struct.origin && asId(struct.origin),
    rightOrigin: struct.rightOrigin && asId(struct.rightOrigin),
    parent:
      parent === null
        ? null
        : typeof parent === "string"
          ? { root: parent }
          : { item: asId(parent) },
    parentSub: struct.parentSub,
    content: yjsContent(struct.content),
  };
}

const asId = (id: Y.ID): Id => ({ client: id.client, clock: id.clock });

function yjsContent(content: Y.Item["content"]): Content {
  if (content instanceof Y.ContentDeleted) return { kind: "deleted", length: content.len };
  if (content instanceof Y.ContentJSON) return { kind: "json", values: content.arr };
  if (content instanceof Y.ContentBinary) return { kind: "binary", bytes: content.content };
  if (content instanceof Y.ContentString) return { kind: "string", text: content.str };
  if (content instanceof Y.ContentEmbed) return { kind: "embed", value: content.embed };
  if (content instanceof Y.ContentFormat)
    return { kind: "format", key: content.key, value: content.value };
  if (content instanceof Y.ContentAny) return { kind: "any", values: content.arr };
  if (content instanceof Y.ContentDoc)
    return { kind: "doc", guid: content.doc.guid, options: content.opts };
  if (content instanceof Y.ContentType) {
    const type = TYPE_NAMES[typeNumber(content.type)];
    if (type === undefined) throw new Error("unknown type");
    if (content.type instanceof Y.XmlElement)
      return { kind: "type", type, name: content.type.nodeName };
    if (content.type instanceof Y.XmlHook)
      return { kind: "type", type, name: content.type.hookName };
    return { kind: "type", type };
  }
  throw new Error(`unknown content ${content.constructor.name}`);
}

/** The order matters: XmlHook extends Map, XmlText extends Text, XmlElement extends XmlFragment. */
function typeNumber(type: Y.AbstractType<unknown>): number {
  if (type instanceof Y.XmlHook) return 5;
  if (type instanceof Y.XmlText) return 6;
  if (type instanceof Y.XmlElement) return 3;
  if (type instanceof Y.XmlFragment) return 4;
  if (type instanceof Y.Array) return 0;
  if (type instanceof Y.Map) return 1;
  if (type instanceof Y.Text) return 2;
  return -1;
}

function expectSameAsYjs(update: Uint8Array) {
  expect(decodeUpdate(update)).toEqual(yjsReading(update));
}

const docWith = (client: number) => {
  const doc = new Y.Doc();
  doc.clientID = client;
  return doc;
};

describe("decodeUpdate reads what Yjs reads", () => {
  it("text, maps, arrays and every value type", () => {
    const doc = docWith(7);
    doc.getText("text").insert(0, "héllo 👋");
    // A text that starts with a byte-order mark keeps it: a plain TextDecoder would drop it.
    doc.getText("bom").insert(0, "\uFEFFfirst");
    const map = doc.getMap("map");
    map.set("n", 42);
    map.set("negative", -300);
    map.set("float", 1.5);
    map.set("big", 2n ** 60n);
    map.set("none", null);
    map.set("yes", true);
    map.set("object", { a: [1, "two", { three: false }] });
    map.set("bytes", new Uint8Array([1, 2, 3]));
    // `undefined` can't go in through the API; the hand-written JSON update below has one.
    doc.getArray("array").insert(0, ["s", 0, -0.25, ["nested"]]);
    expectSameAsYjs(Y.encodeStateAsUpdate(doc));
  });

  it("nested types, rich text, embeds, XML and subdocuments", () => {
    const doc = docWith(3);
    const root = doc.getMap("root");
    const text = new Y.Text();
    root.set("text", text);
    text.insert(0, "bold", { bold: true });
    text.insertEmbed(4, { image: "cat.png" });
    const list = new Y.Array<unknown>();
    root.set("list", list);
    list.push([new Y.Map(), new Y.Text("inner")]);
    const xml = doc.getXmlFragment("xml");
    const element = new Y.XmlElement("p");
    xml.insert(0, [element, new Y.XmlText("hi")]);
    element.setAttribute("class", "lead");
    // Yjs accepts a hook in an element, though its types say otherwise.
    element.insert(0, [new Y.XmlHook("widget") as unknown as Y.XmlText]);
    root.set("sub", new Y.Doc({ guid: "sub-guid", meta: { kind: "page" } }));
    expectSameAsYjs(Y.encodeStateAsUpdate(doc));
  });

  it("deleted items, garbage-collected ones, and the delete set", () => {
    const doc = docWith(9);
    const text = doc.getText("text");
    text.insert(0, "abcdef");
    text.delete(1, 3);
    const map = doc.getMap("map");
    map.set("k", new Y.Map());
    (map.get("k") as Y.Map<number>).set("x", 1);
    map.set("k", 2); // the old nested map, and what's in it, are collected
    const update = Y.encodeStateAsUpdate(doc);
    const decoded = decodeUpdate(update);
    expect(decoded.structs.some((s) => s.kind === "gc")).toBe(true);
    expect(decoded.structs.some((s) => s.kind === "item" && s.content.kind === "deleted")).toBe(
      true,
    );
    expect(decoded.deletes.length).toBeGreaterThan(0);
    expectSameAsYjs(update);
  });

  it("gaps, as in a merge of updates that aren't consecutive", () => {
    const doc = docWith(5);
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    const text = doc.getText("t");
    for (const word of ["one ", "two ", "three"]) text.insert(text.length, word);
    const merged = Y.mergeUpdates([updates[0] as Uint8Array, updates[2] as Uint8Array]);
    expect(decodeUpdate(merged).structs.map((s) => s.kind)).toContain("skip");
    expectSameAsYjs(merged);
  });

  it("an empty update is two zeros", () => {
    const update = Y.encodeStateAsUpdate(new Y.Doc());
    expect([...update]).toEqual([0, 0]);
    expect(decodeUpdate(update)).toEqual({ structs: [], deletes: [] });
  });

  it("random edits by several people, synced in random order", () => {
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 40 }), (edits) => {
        const docs = [docWith(1), docWith(2), docWith(1 << 20)];
        const updates: Uint8Array[] = [];
        for (const doc of docs) doc.on("update", (u: Uint8Array) => updates.push(u));
        for (const e of edits) apply(docs, e);
        for (const doc of docs) expectSameAsYjs(Y.encodeStateAsUpdate(doc));
        for (const update of updates) expectSameAsYjs(update);
      }),
      { numRuns: 200 },
    );
  });
});

describe("an update written by hand", () => {
  it("is one Yjs accepts", () => {
    // Client 1 inserts "hi" at the start of the top-level text "t".
    const hand = new Uint8Array([
      1, // one client has structs
      1, // it has one struct
      1, // client 1
      0, // the first struct's clock is 0
      0x04, // info: content 4 (string); no origins, no map key
      1, // the parent is a top-level type...
      ...[1, 0x74], // ...named "t": 1 byte, then "t" in UTF-8
      ...[2, 0x68, 0x69], // the text: 2 bytes, then "hi"
      0, // nothing deleted
    ]);
    expectSameAsYjs(hand);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, hand);
    expect(doc.getText("t").toString()).toBe("hi");
    // Yjs writes the same bytes for the same edit.
    const same = docWith(1);
    same.getText("t").insert(0, "hi");
    expect(Y.encodeStateAsUpdate(same)).toEqual(hand);
  });

  it("can use the JSON content older versions of Yjs wrote", () => {
    const json = (s: string) => [s.length, ...new TextEncoder().encode(s)];
    const hand = new Uint8Array([
      ...[1, 1, 4, 0], // one client, one struct, client 4, first clock 0
      0x02, // info: content 2 (JSON)
      ...[1, ...json("a")], // parent: the top-level type "a"
      ...[2, ...json('{"x":1}'), ...json("undefined")], // two values, as JSON text
      0, // nothing deleted
    ]);
    expectSameAsYjs(hand);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, hand);
    expect(doc.getArray("a").toJSON()).toEqual([{ x: 1 }, undefined]);
  });

  it("is refused when it's cut short or has bytes left over", () => {
    const doc = docWith(1);
    doc.getText("t").insert(0, "hi");
    const update = Y.encodeStateAsUpdate(doc);
    expect(() => decodeUpdate(update.subarray(0, update.length - 2))).toThrow(/ends early/);
    expect(() => decodeUpdate(new Uint8Array([...update, 0]))).toThrow(/left over/);
  });
});

describe("explain", () => {
  it("shows each value next to its bytes", () => {
    const doc = docWith(300);
    doc.getText("t").insert(0, "hi");
    doc.getMap("m").set("k", 1);
    doc.getText("t").delete(0, 1);
    // Deleting "h" kept its place but dropped its content: struct 1 is now
    // "1 deleted", and the delete set says (300, 0) is deleted.
    expect(`\n${explain(Y.encodeStateAsUpdate(doc))}\n`).toBe(`
01     clients with structs: 1
03     client group 1 / structs: 3
ac 02  client group 1 / client: 300
00     client group 1 / first clock: 0
01     client group 1 / struct 1 / info: 1
01     client group 1 / struct 1 / parent is a root type (1) or an item (0): 1
01 74  client group 1 / struct 1 / root type name: "t"
01     client group 1 / struct 1 / content / deleted length: 1
84     client group 1 / struct 2 / info: 132
ac 02  client group 1 / struct 2 / origin / client: 300
00     client group 1 / struct 2 / origin / clock: 0
01 69  client group 1 / struct 2 / content / text: "i"
28     client group 1 / struct 3 / info: 40
01     client group 1 / struct 3 / parent is a root type (1) or an item (0): 1
01 6d  client group 1 / struct 3 / root type name: "m"
01 6b  client group 1 / struct 3 / map key: "k"
01     client group 1 / struct 3 / content / values: 1
7d 01  client group 1 / struct 3 / content / value 1: 1
01     clients with deletes: 1
ac 02  delete group 1 / client: 300
01     delete group 1 / ranges: 1
00     delete group 1 / from clock: 0
01     delete group 1 / length: 1
`);
  });
});

// Random edits for the property test.

type Edit =
  | { op: "type"; who: number; at: number; text: string }
  | { op: "erase"; who: number; at: number; count: number }
  | { op: "set"; who: number; key: string; value: unknown }
  | { op: "nest"; who: number; key: string }
  | { op: "push"; who: number; values: unknown[] }
  | { op: "sync"; from: number; to: number };

const who = fc.nat(2);
const value = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.uint8Array({ maxLength: 4 }),
  // Yjs refuses objects without Object's prototype.
  fc.dictionary(fc.string({ maxLength: 3 }), fc.oneof(fc.integer(), fc.string()), {
    noNullPrototype: true,
  }),
);
const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    op: fc.constant("type" as const),
    who,
    at: fc.nat(),
    text: fc.string({ unit: "grapheme", minLength: 1, maxLength: 5 }),
  }),
  fc.record({
    op: fc.constant("erase" as const),
    who,
    at: fc.nat(),
    count: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({ op: fc.constant("set" as const), who, key: fc.constantFrom("a", "b", "c"), value }),
  fc.record({ op: fc.constant("nest" as const), who, key: fc.constantFrom("a", "b") }),
  fc.record({
    op: fc.constant("push" as const),
    who,
    values: fc.array(value, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ op: fc.constant("sync" as const), from: who, to: who }),
);

function apply(docs: Y.Doc[], e: Edit) {
  if (e.op === "sync") {
    const from = docs[e.from] as Y.Doc;
    const to = docs[e.to] as Y.Doc;
    Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
    return;
  }
  const doc = docs[e.who] as Y.Doc;
  const text = doc.getText("text");
  const map = doc.getMap("map");
  switch (e.op) {
    case "type":
      text.insert(e.at % (text.length + 1), e.text);
      break;
    case "erase":
      if (text.length > 0) {
        const at = e.at % text.length;
        text.delete(at, Math.min(e.count, text.length - at));
      }
      break;
    case "set":
      map.set(e.key, e.value);
      break;
    case "nest": {
      const inner = new Y.Map<unknown>();
      map.set(e.key, inner);
      inner.set("x", 1);
      break;
    }
    case "push":
      doc.getArray("list").push(e.values);
      break;
  }
}
