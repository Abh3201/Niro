import type { Shape, ShapeId } from "@niro/doc";
import { createYDocStore } from "@niro/doc/yjs";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { decodeWithNotes } from "./decode";

/** What a note's bytes are for, from its label ("client group 1 / struct 2 / map key"). */
function purpose(label: string): string {
  const parts = label.split(" / ");
  const last = parts.at(-1) ?? "";
  if (parts.includes("content")) return "values";
  if (last === "map key") return "keys";
  if (last === "root type name") return "root names";
  if (last === "info") return "info bytes";
  if (last === "client" || last === "clock" || last === "first clock") return "ids";
  return "counts and flags";
}

function breakdown(update: Uint8Array): Record<string, number> {
  const bytes: Record<string, number> = {};
  for (const n of decodeWithNotes(update).notes) {
    const p = purpose(n.label);
    bytes[p] = (bytes[p] ?? 0) + n.end - n.start;
  }
  return bytes;
}

it("where the bytes of one sticky note go", () => {
  const doc = new Y.Doc();
  doc.clientID = 2_394_617_203; // random 32-bit ids, like this one, take 5 bytes
  const store = createYDocStore(doc);
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  const note: Shape = {
    id: "V1StGXR8_Z5jdHi6B-myT" as ShapeId,
    type: "sticky",
    x: 120,
    y: -40,
    w: 200,
    h: 200,
    rotation: 0,
    parentId: null,
    index: "a0",
    color: "yellow",
    text: "",
    points: [],
    from: null,
    to: null,
  };
  store.transact((tx) => tx.add(note));
  store.transact((tx) => tx.editText(note.id, 0, 0, "Ship v0.1"));
  store.transact((tx) => tx.update(note.id, { x: 160 }));
  const [add, type, move] = updates as [Uint8Array, Uint8Array, Uint8Array];

  // Adding the note (and stamping the board's schema version, the first time):
  // each field is an item of its own, and each names its parent, the note's
  // map, by client and clock: 6 of the 66 bytes of ids, ten times over.
  expect(updates.map((u) => u.length)).toEqual([237, 27, 28]);
  expect(breakdown(add)).toMatchInlineSnapshot(`
    {
      "counts and flags": 15,
      "ids": 66,
      "info bytes": 12,
      "keys": 84,
      "root names": 12,
      "values": 48,
    }
  `);
  // Typing "Ship v0.1": its length and 9 bytes of text; the rest says where.
  expect(breakdown(type)).toMatchInlineSnapshot(`
    {
      "counts and flags": 4,
      "ids": 12,
      "info bytes": 1,
      "values": 10,
    }
  `);
  // Moving it: 4 bytes say x is now 160. The rest say where, and that the old
  // x is deleted: a delete set naming the client again, 5 more bytes.
  expect(breakdown(move)).toMatchInlineSnapshot(`
    {
      "counts and flags": 6,
      "ids": 17,
      "info bytes": 1,
      "values": 4,
    }
  `);

  // Yjs's v2 format stores each column (clients, clocks, keys...) together
  // and run-length encodes it: smaller for a big update, bigger for a small one.
  expect(updates.map((u) => Y.convertUpdateFormatV1ToV2(u).length)).toEqual([168, 34, 35]);
});
