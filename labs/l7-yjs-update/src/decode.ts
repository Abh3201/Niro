import { type Note, Reader } from "./reader";

/**
 * A Yjs update (format v1, what `Y.encodeStateAsUpdate` returns), decoded
 * by hand from the bytes. Written from Yjs's encoder, not from its decoder,
 * and checked against `Y.decodeUpdate` in the tests.
 *
 * An update is two lists:
 *
 * 1. Structs, grouped by the client that made them. Every struct has an id,
 *    (client, clock), and covers `length` clock values: inserting "hi" is
 *    one struct of length 2, ids (c, 5) and (c, 6). Within a client the
 *    structs are consecutive, so only the first clock is written.
 * 2. A delete set: ranges of ids that are deleted. Deleting never rewrites
 *    a struct in an update; it's said separately, as ranges.
 */

export interface Id {
  readonly client: number;
  readonly clock: number;
}

/** Shared types, by the number Yjs stores for them. */
export const TYPE_NAMES = [
  "Array",
  "Map",
  "Text",
  "XmlElement",
  "XmlFragment",
  "XmlHook",
  "XmlText",
] as const;
export type TypeName = (typeof TYPE_NAMES)[number];

/** What an item holds, by the content number in its info byte. */
export type Content =
  /** 1: stands for `length` deleted items whose content was dropped. */
  | { readonly kind: "deleted"; readonly length: number }
  /** 2: values written as JSON strings (older Yjs; still readable). */
  | { readonly kind: "json"; readonly values: readonly unknown[] }
  /** 3: bytes, one item. */
  | { readonly kind: "binary"; readonly bytes: Uint8Array }
  /** 4: text; its length is in UTF-16 code units, as JavaScript counts. */
  | { readonly kind: "string"; readonly text: string }
  /** 5: an embed in rich text (an image, say), as JSON. */
  | { readonly kind: "embed"; readonly value: unknown }
  /** 6: a formatting mark in rich text, like bold starting or ending. */
  | { readonly kind: "format"; readonly key: string; readonly value: unknown }
  /** 7: a nested shared type; what's in it are items whose parent is this item. */
  | { readonly kind: "type"; readonly type: TypeName; readonly name?: string }
  /** 8: values in lib0's own encoding: what arrays and maps hold today. */
  | { readonly kind: "any"; readonly values: readonly unknown[] }
  /** 9: a subdocument, by its guid. */
  | { readonly kind: "doc"; readonly guid: string; readonly options: unknown };

/** Where an item lives: a top-level type by its name, or a nested type by the item holding it. */
export type Parent = { readonly root: string } | { readonly item: Id };

export type Struct =
  /** Garbage-collected: deleted items whose content and position are gone. */
  | { readonly kind: "gc"; readonly id: Id; readonly length: number }
  /** A gap: ids this update doesn't carry. */
  | { readonly kind: "skip"; readonly id: Id; readonly length: number }
  | {
      readonly kind: "item";
      readonly id: Id;
      readonly length: number;
      /** The item that was on the left when this one was inserted. */
      readonly origin: Id | null;
      /** The item that was on the right when this one was inserted. */
      readonly rightOrigin: Id | null;
      /** Written only when neither origin is: otherwise it's the origin's parent. */
      readonly parent: Parent | null;
      /** The key, for an item in a map. Written only with the parent. */
      readonly parentSub: string | null;
      readonly content: Content;
    };

export interface DeleteRange {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
}

export interface Update {
  readonly structs: readonly Struct[];
  readonly deletes: readonly DeleteRange[];
}

/** Bits of an item's info byte, above the 5-bit content number. */
const HAS_ORIGIN = 0x80;
const HAS_RIGHT_ORIGIN = 0x40;
const HAS_PARENT_SUB = 0x20;
const CONTENT = 0x1f;

const GC = 0;
const SKIP = 10;

export function decodeUpdate(bytes: Uint8Array): Update {
  return decodeWith(new Reader(bytes));
}

/** The update, and a note for every value read from it. */
export function decodeWithNotes(bytes: Uint8Array): { update: Update; notes: Note[] } {
  const reader = new Reader(bytes);
  const update = decodeWith(reader);
  return { update, notes: reader.notes };
}

function decodeWith(r: Reader): Update {
  const structs: Struct[] = [];
  const groups = r.varUint("clients with structs");
  for (let g = 0; g < groups; g++) {
    r.within(`client group ${g + 1}`, () => {
      const count = r.varUint("structs");
      const client = r.varUint("client");
      let clock = r.varUint("first clock");
      for (let i = 0; i < count; i++) {
        const struct = r.within(`struct ${i + 1}`, () => readStruct(r, { client, clock }));
        structs.push(struct);
        clock += struct.length;
      }
    });
  }
  const deletes: DeleteRange[] = [];
  const clients = r.varUint("clients with deletes");
  for (let c = 0; c < clients; c++) {
    r.within(`delete group ${c + 1}`, () => {
      const client = r.varUint("client");
      const ranges = r.varUint("ranges");
      for (let i = 0; i < ranges; i++) {
        const clock = r.varUint("from clock");
        const length = r.varUint("length");
        deletes.push({ client, clock, length });
      }
    });
  }
  if (!r.done) throw new Error(`${r.bytes.length - r.pos} bytes left over at ${r.pos}`);
  return { structs, deletes };
}

function readStruct(r: Reader, id: Id): Struct {
  const info = r.uint8("info");
  const ref = info & CONTENT;
  if (ref === GC) return { kind: "gc", id, length: r.varUint("gc length") };
  if (ref === SKIP) return { kind: "skip", id, length: r.varUint("skip length") };

  const origin = info & HAS_ORIGIN ? readId(r, "origin") : null;
  const rightOrigin = info & HAS_RIGHT_ORIGIN ? readId(r, "right origin") : null;
  let parent: Parent | null = null;
  let parentSub: string | null = null;
  // With an origin, the parent is the origin's parent: it isn't repeated.
  if (origin === null && rightOrigin === null) {
    const isRoot = r.varUint("parent is a root type (1) or an item (0)") === 1;
    parent = isRoot ? { root: r.varString("root type name") } : { item: readId(r, "parent item") };
    if (info & HAS_PARENT_SUB) parentSub = r.varString("map key");
  }
  const content = r.within("content", () => readContent(r, ref));
  return {
    kind: "item",
    id,
    length: contentLength(content),
    origin,
    rightOrigin,
    parent,
    parentSub,
    content,
  };
}

function readId(r: Reader, label: string): Id {
  return r.within(label, () => ({ client: r.varUint("client"), clock: r.varUint("clock") }));
}

function readContent(r: Reader, ref: number): Content {
  switch (ref) {
    case 1:
      return { kind: "deleted", length: r.varUint("deleted length") };
    case 2: {
      const count = r.varUint("values");
      const values: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const json = r.varString(`value ${i + 1} as JSON`);
        values.push(json === "undefined" ? undefined : JSON.parse(json));
      }
      return { kind: "json", values };
    }
    case 3:
      return { kind: "binary", bytes: r.varBytes("bytes") };
    case 4:
      return { kind: "string", text: r.varString("text") };
    case 5:
      return { kind: "embed", value: JSON.parse(r.varString("embed as JSON")) };
    case 6:
      return {
        kind: "format",
        key: r.varString("format key"),
        value: JSON.parse(r.varString("format value as JSON")),
      };
    case 7: {
      const number = r.varUint("type");
      const type = TYPE_NAMES[number];
      if (type === undefined) throw new Error(`unknown type ${number}`);
      // An XML element stores its tag name, a hook its name.
      if (type === "XmlElement" || type === "XmlHook") {
        return { kind: "type", type, name: r.varString("name") };
      }
      return { kind: "type", type };
    }
    case 8: {
      const count = r.varUint("values");
      const values: unknown[] = [];
      for (let i = 0; i < count; i++) values.push(r.any(`value ${i + 1}`));
      return { kind: "any", values };
    }
    case 9:
      return { kind: "doc", guid: r.varString("guid"), options: r.any("options") };
    default:
      throw new Error(`unknown content ${ref}`);
  }
}

/** How many clock values an item covers. */
function contentLength(content: Content): number {
  switch (content.kind) {
    case "deleted":
      return content.length;
    case "json":
    case "any":
      return content.values.length;
    case "string":
      return content.text.length;
    default:
      return 1;
  }
}

/**
 * The update as hex, one value a line, each with what it means:
 *
 *     01           clients with structs: 1
 *     02           client group 1 / structs: 2
 */
export function explain(bytes: Uint8Array): string {
  const { notes } = decodeWithNotes(bytes);
  const hex = notes.map((n) => Array.from(bytes.subarray(n.start, n.end), byteHex).join(" "));
  const width = Math.min(Math.max(...hex.map((h) => h.length)), 36);
  return notes
    .map((n, i) => {
      const h = hex[i] ?? "";
      const shown = h.length > width ? `${h.slice(0, width - 3)}...` : h;
      return `${shown.padEnd(width)}  ${n.label}: ${n.value}`;
    })
    .join("\n");
}

const byteHex = (b: number) => b.toString(16).padStart(2, "0");
