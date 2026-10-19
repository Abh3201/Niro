import type { Shape, ShapeId } from "@niro/doc";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { transact } from "./board-tx";
import { Scene } from "./scene";
import { memoryDoc } from "./test-doc";

const id = (s: string) => s as ShapeId;

const shape = (name: string, x: number, y: number, patch: Partial<Shape> = {}): Shape => ({
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

const frame = (name: string, x: number, y: number, patch: Partial<Shape> = {}) =>
  shape(name, x, y, { type: "frame", w: 200, h: 200, color: "grey", ...patch });

function board(shapes: Shape[]) {
  const doc = memoryDoc(shapes);
  const scene = new Scene(doc);
  doc.subscribe((changes) => scene.apply(changes));
  const stored = (name: string) => doc.get(id(name)) as Shape;
  const drawn = (name: string) => scene.get(id(name)) as Shape;
  return { doc, scene, stored, drawn };
}

describe("board coordinates", () => {
  // Frame "outer" at (100, 100) holds frame "inner" 10 in, which holds "s" 5 in.
  const nested = () => [
    frame("outer", 100, 100),
    frame("inner", 10, 10, { parentId: id("outer"), w: 100, h: 100 }),
    shape("s", 5, 5, { parentId: id("inner") }),
  ];

  it("draws a shape in a frame where it is in the frame", () => {
    const { drawn } = board(nested());
    expect(drawn("inner")).toMatchObject({ x: 110, y: 110 });
    expect(drawn("s")).toMatchObject({ x: 115, y: 115 });
  });

  it("moves a frame by writing the frame alone", () => {
    const { doc, scene, stored, drawn } = board(nested());
    const inner = stored("inner");
    const s = stored("s");
    transact(doc, scene, (tx) => tx.update(id("outer"), { x: 300, y: 100 }));
    expect(stored("outer")).toMatchObject({ x: 300, y: 100 });
    expect(stored("inner")).toBe(inner);
    expect(stored("s")).toBe(s);
    expect(drawn("s")).toMatchObject({ x: 315, y: 115 });
  });

  it("stores shapes added or moved in a frame where they are in it", () => {
    const { doc, scene, stored, drawn } = board(nested());
    transact(doc, scene, (tx) => {
      tx.add(shape("new", 150, 160, { parentId: id("inner") }));
      tx.update(id("s"), { x: 200, y: 200 });
    });
    expect(stored("new")).toMatchObject({ x: 40, y: 50 });
    expect(stored("s")).toMatchObject({ x: 90, y: 90 });
    expect(drawn("new")).toMatchObject({ x: 150, y: 160 });
  });

  it("keeps a shape where it is on the board when it changes frames", () => {
    const { doc, scene, stored, drawn } = board([...nested(), shape("loose", 130, 140)]);
    transact(doc, scene, (tx) => {
      tx.update(id("loose"), { parentId: id("inner") });
      tx.update(id("s"), { parentId: null });
    });
    expect(stored("loose")).toMatchObject({ x: 20, y: 30 });
    expect(stored("s")).toMatchObject({ x: 115, y: 115 });
    expect(drawn("loose")).toMatchObject({ x: 130, y: 140 });
    expect(drawn("s")).toMatchObject({ x: 115, y: 115 });
  });

  it("places what's in a frame against where the frame goes in the same edit", () => {
    const { doc, scene, stored, drawn } = board(nested());
    // Both "outer" and "s" move, as when a group around them is scaled.
    transact(doc, scene, (tx) => {
      tx.update(id("outer"), { x: 0, y: 0 });
      tx.update(id("s"), { x: 50, y: 60 });
    });
    expect(stored("s")).toMatchObject({ x: 40, y: 50 });
    expect(drawn("s")).toMatchObject({ x: 50, y: 60 });
    // A new frame and what's added in it, together: copies, for one.
    transact(doc, scene, (tx) => {
      tx.add(frame("copy", 500, 500));
      tx.add(shape("in-copy", 520, 530, { parentId: id("copy") }));
    });
    expect(stored("in-copy")).toMatchObject({ x: 20, y: 30 });
  });

  it("keeps a group's shapes where they are when the group moves into a frame", () => {
    const { doc, scene, stored, drawn } = board([
      frame("f", 100, 100),
      shape("g", 0, 0, { type: "group", w: 0, h: 0, index: "a1" }),
      shape("a", 120, 130, { parentId: id("g") }),
      frame("f2", 150, 150, { parentId: id("g"), w: 20, h: 20, index: "a1" }),
      shape("in-f2", 2, 3, { parentId: id("f2") }),
    ]);
    transact(doc, scene, (tx) => tx.update(id("g"), { parentId: id("f") }));
    expect(stored("a")).toMatchObject({ x: 20, y: 30 });
    expect(stored("f2")).toMatchObject({ x: 50, y: 50 });
    // Inside f2, nothing changes: f2 is still where it's measured from.
    expect(stored("in-f2")).toMatchObject({ x: 2, y: 3 });
    expect(drawn("a")).toMatchObject({ x: 120, y: 130 });
    expect(drawn("in-f2")).toMatchObject({ x: 152, y: 153 });
  });

  it("leaves positions alone on edits that don't move anything", () => {
    const { doc, scene, stored } = board(nested());
    transact(doc, scene, (tx) => tx.update(id("s"), { color: "red", index: "a5" }));
    expect(stored("s")).toMatchObject({ x: 5, y: 5, color: "red" });
  });

  it("puts any shape anywhere, in any frame, where it was asked to go", () => {
    const point = fc.record({
      x: fc.integer({ min: -1000, max: 1000 }),
      y: fc.integer({ min: -1000, max: 1000 }),
    });
    const home = fc.constantFrom<ShapeId | null>(null, id("outer"), id("inner"));
    fc.assert(
      fc.property(point, home, point, home, (to, parent, frameTo, frameParent) => {
        const { doc, scene, drawn } = board(nested());
        // Move the shape and maybe the outer frame, each possibly to a new parent.
        transact(doc, scene, (tx) => {
          tx.update(id("s"), { ...to, parentId: parent });
          if (frameParent !== id("outer") && frameParent !== id("inner"))
            tx.update(id("outer"), { ...frameTo, parentId: frameParent });
        });
        expect(drawn("s")).toMatchObject(to);
      }),
    );
  });
});
