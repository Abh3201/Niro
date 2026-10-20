import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { presentationOrder, slideView } from "./presentation";
import { Scene } from "./scene";
import { memoryDoc } from "./test-doc";

const frame = (id: string, x: number, y: number, patch: Partial<Shape> = {}): Shape => ({
  id: id as ShapeId,
  type: "frame",
  x,
  y,
  w: 400,
  h: 300,
  rotation: 0,
  parentId: null,
  index: "a0",
  color: "grey",
  text: id,
  points: [],
  from: null,
  to: null,
  ...patch,
});

describe("presentationOrder", () => {
  it("reads frames in rows, left to right, however the rows are slightly out of line", () => {
    const scene = new Scene(
      memoryDoc([frame("d", 500, 460), frame("b", 500, 20), frame("c", 0, 450), frame("a", 0, 0)]),
    );
    expect(presentationOrder(scene)).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves out frames inside frames, and shapes that aren't frames", () => {
    const scene = new Scene(
      memoryDoc([
        frame("outer", 0, 0, { w: 1000, h: 1000 }),
        frame("inner", 100, 100, { parentId: "outer" as ShapeId, w: 100, h: 100 }),
        { ...frame("note", 0, 2000), type: "sticky" },
      ]),
    );
    expect(presentationOrder(scene)).toEqual(["outer"]);
  });

  it("is empty without frames", () => {
    expect(presentationOrder(new Scene(memoryDoc()))).toEqual([]);
  });
});

describe("slideView", () => {
  it("covers the frame and its name, with room around", () => {
    const scene = new Scene(memoryDoc([frame("a", 100, 200)]));
    const view = slideView(scene, "a" as ShapeId);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.x).toBeLessThan(100);
    expect(view.x + view.w).toBeGreaterThan(500);
    expect(view.y).toBeLessThan(200);
    expect(view.y + view.h).toBeGreaterThan(500);
    expect(slideView(scene, "gone" as ShapeId)).toBeNull();
  });
});
