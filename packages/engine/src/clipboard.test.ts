import type { Shape, ShapeId, Tx } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { transact } from "./board-tx";
import { copyShapes, parseClipping, pasteShapes, serializeClipping } from "./clipboard";
import { Scene } from "./scene";
import { memoryDoc } from "./test-doc";

const id = (s: string) => s as ShapeId;

const box = (name: string, x: number, y: number, patch: Partial<Shape> = {}): Shape => ({
  id: id(name),
  type: "rectangle",
  x,
  y,
  w: 10,
  h: 10,
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

function board(shapes: Shape[]) {
  const doc = memoryDoc(shapes);
  const scene = new Scene(doc);
  doc.subscribe((changes) => scene.apply(changes));
  const edit = <T>(fn: (tx: Tx) => T): T => {
    let result: T | undefined;
    transact(doc, scene, (tx) => {
      result = fn(tx);
    });
    return result as T;
  };
  return { scene, edit };
}

describe("copy and paste", () => {
  const source = () =>
    board([
      box("f", 0, 0, { type: "frame", color: "grey", w: 200, h: 200 }),
      box("a", 10, 10, { parentId: id("f"), index: "a0" }),
      box("b", 100, 10, { parentId: id("f"), index: "a1" }),
      box("arrow", 0, 0, {
        type: "arrow",
        parentId: id("f"),
        index: "a2",
        from: id("a"),
        to: id("b"),
      }),
      box("outside", 500, 0, { reactions: { like: ["someone-1234"] } }),
    ]);

  it("copies shapes as drawn, with what's in them, without reactions or a parent", () => {
    const { scene } = source();
    const copied = copyShapes(scene, [id("f"), id("outside")]);
    expect(copied.map((s) => s.id)).toEqual(["f", "a", "b", "arrow", "outside"]);
    expect(copied[0]?.parentId).toBeNull();
    expect(copied[1]?.parentId).toBe("f");
    expect(copied[4]?.reactions).toBeUndefined();
  });

  it("pastes into the same board with new ids, remapped parents and arrow ends", () => {
    const { scene, edit } = source();
    const copied = copyShapes(scene, [id("f")]);
    const [frame] = edit((tx) => pasteShapes(scene, tx, copied, { x: 1000, y: 1000 }));
    expect(scene.size).toBe(9);
    const inner = scene.childrenOf(frame as ShapeId).map((c) => scene.get(c) as Shape);
    expect(inner.map((s) => s.type)).toEqual(["rectangle", "rectangle", "arrow"]);
    const arrow = inner[2] as Shape;
    expect([arrow.from, arrow.to]).toEqual([inner[0]?.id, inner[1]?.id]);
    // Centered on the paste point.
    expect(scene.get(frame as ShapeId)).toMatchObject({ x: 900, y: 900 });
  });

  it("drops references to shapes that weren't copied", () => {
    const { scene, edit } = source();
    const copied = copyShapes(scene, [id("a"), id("arrow")]);
    const [first, second] = edit((tx) => pasteShapes(scene, tx, copied, { x: 0, y: 0 }));
    const arrow = scene.get(second as ShapeId) as Shape;
    expect(arrow.from).toBe(first);
    expect(arrow.to).toBeNull();
  });

  it("round-trips through the clipboard text, and refuses other text", () => {
    const { scene } = source();
    const copied = copyShapes(scene, [id("outside")]);
    const parsed = parseClipping(serializeClipping({ board: "b1", shapes: copied }));
    expect(parsed?.board).toBe("b1");
    expect(parsed?.shapes).toHaveLength(1);
    expect(parseClipping("hello")).toBeNull();
    expect(parseClipping('{"format":"other"}')).toBeNull();
    expect(parseClipping("null")).toBeNull();
  });

  it("repairs hostile clipboard contents instead of trusting them", () => {
    const text = JSON.stringify({
      format: "niro/shapes",
      version: 1,
      board: 7,
      shapes: [
        { id: "x", type: "rectangle", x: "1", w: -5, h: 1e300, color: "pink" },
        { id: "x", type: "rectangle" },
        { id: "y", type: "nope" },
        null,
        { id: "z", type: "image", asset: "../../etc/passwd" },
      ],
    });
    const parsed = parseClipping(text);
    expect(parsed?.board).toBe("");
    expect(parsed?.shapes.map((s) => s.id)).toEqual(["x", "z"]);
    expect(parsed?.shapes[0]).toMatchObject({ x: 0, w: 5, color: "blue" });
    expect(parsed?.shapes[1]?.asset).toBe("");
  });

  it("pastes nothing for an empty group, and maps image files", () => {
    const { scene, edit } = board([]);
    const group = box("g", 0, 0, { type: "group", w: 0, h: 0 });
    expect(edit((tx) => pasteShapes(scene, tx, [group], { x: 0, y: 0 }))).toEqual([]);
    const hash = "a".repeat(64);
    const other = "b".repeat(64);
    const image = box("i", 0, 0, { type: "image", asset: hash });
    const [copy] = edit((tx) => pasteShapes(scene, tx, [image], { x: 0, y: 0 }, () => other));
    expect(scene.get(copy as ShapeId)?.asset).toBe(other);
  });
});

describe("pasting onto a sticky note", () => {
  const note = box("note", 0, 0, { type: "sticky", color: "yellow", w: 200, h: 200 });
  const image = (name: string, w: number) =>
    box(name, 0, 0, { type: "image", color: "grey", w, h: w, asset: "a".repeat(64) });

  it("puts strokes and images that fit on the note they land on, and leaves the rest on the board", () => {
    const { scene, edit } = board([note]);
    const [small] = edit((tx) => pasteShapes(scene, tx, [image("i", 50)], { x: 100, y: 100 }));
    expect(scene.parentOf(small as ShapeId)).toBe("note");
    const [ink] = edit((tx) =>
      pasteShapes(scene, tx, [box("s", 0, 0, { type: "freehand", points: [0, 0, 50] })], {
        x: 50,
        y: 50,
      }),
    );
    expect(scene.parentOf(ink as ShapeId)).toBe("note");
    const [rect] = edit((tx) => pasteShapes(scene, tx, [box("r", 0, 0)], { x: 100, y: 100 }));
    expect(scene.parentOf(rect as ShapeId)).toBeNull();
    // Last: it covers the note, so nothing pasted after it lands on the note.
    const [big] = edit((tx) => pasteShapes(scene, tx, [image("j", 300)], { x: 100, y: 100 }));
    expect(scene.parentOf(big as ShapeId)).toBeNull();
  });
});
