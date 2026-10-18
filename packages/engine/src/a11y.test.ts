import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { describeShape, nextInReadingOrder, readingOrder } from "./a11y";
import { Scene } from "./scene";
import { memoryDoc } from "./test-doc";

const shape = (id: string, patch: Partial<Shape> = {}): Shape => ({
  id: id as ShapeId,
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

const id = (s: string) => s as ShapeId;

// A frame top right holding two notes; a group top left; a box below them.
const board = () =>
  new Scene(
    memoryDoc([
      shape("frame", { type: "frame", x: 500, y: 0, w: 400, h: 300, text: "Ideas" }),
      shape("b-note", { type: "sticky", parentId: id("frame"), x: 200, y: 20, text: "Second" }),
      shape("a-note", { type: "sticky", parentId: id("frame"), x: 20, y: 20, text: "First" }),
      shape("group", { type: "group", w: 0, h: 0 }),
      shape("g1", { parentId: id("group"), x: 0, y: 10 }),
      shape("g2", { parentId: id("group"), x: 120, y: 10, type: "ellipse", color: "green" }),
      shape("box", { y: 500, text: "  Lots   of\nspace  " }),
    ]),
  );

describe("readingOrder", () => {
  it("goes top to bottom, left to right, into frames but not groups", () => {
    expect(readingOrder(board())).toEqual(["frame", "a-note", "b-note", "group", "box"]);
  });
});

describe("nextInReadingOrder", () => {
  it("steps forward and back, and runs out at either end", () => {
    const scene = board();
    expect(nextInReadingOrder(scene, null, 1)).toBe("frame");
    expect(nextInReadingOrder(scene, null, -1)).toBeNull();
    expect(nextInReadingOrder(scene, id("a-note"), 1)).toBe("b-note");
    expect(nextInReadingOrder(scene, id("a-note"), -1)).toBe("frame");
    expect(nextInReadingOrder(scene, id("box"), 1)).toBeNull();
  });

  it("carries on from a group when a shape inside it is selected", () => {
    expect(nextInReadingOrder(board(), id("g2"), 1)).toBe("box");
  });
});

describe("describeShape", () => {
  it("says what a shape is, its color and its text", () => {
    const scene = board();
    expect(describeShape(scene, id("a-note"))).toBe("Sticky note, blue: First");
    expect(describeShape(scene, id("g2"))).toBe("Ellipse, green");
    expect(describeShape(scene, id("box"))).toBe("Rectangle, blue: Lots of space");
    expect(describeShape(scene, id("frame"))).toBe('Frame "Ideas", holding 2 shapes');
    expect(describeShape(scene, id("group"))).toBe("Group of 2 shapes");
  });

  it("cuts long text short", () => {
    const scene = new Scene(memoryDoc([shape("t", { type: "text", text: "word ".repeat(40) })]));
    const words = describeShape(scene, id("t"));
    expect(words.startsWith("Text: word word")).toBe(true);
    expect(words.endsWith("…")).toBe(true);
    expect(words.length).toBeLessThan(100);
  });
});
