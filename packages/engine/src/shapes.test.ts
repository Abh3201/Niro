import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { polygonIntersectsBox } from "./geometry";
import { resizeCursor } from "./selection";
import { hitShape, shapeBounds, shapeIntersectsBox } from "./shapes";

const shape = (patch: Partial<Shape>): Shape => ({
  id: "s1" as ShapeId,
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

describe("hitShape", () => {
  it("hits inside a rectangle and misses outside", () => {
    const r = shape({});
    expect(hitShape(r, { x: 50, y: 50 }, 0)).toBe(true);
    expect(hitShape(r, { x: 101, y: 50 }, 0)).toBe(false);
    expect(hitShape(r, { x: 101, y: 50 }, 2)).toBe(true);
  });

  it("misses the corners of an ellipse's bounding box", () => {
    const e = shape({ type: "ellipse" });
    expect(hitShape(e, { x: 50, y: 50 }, 0)).toBe(true);
    expect(hitShape(e, { x: 5, y: 5 }, 0)).toBe(false);
  });

  it("follows a rectangle's rotation", () => {
    // A 100x10 bar turned 90° around its center (50, 5) stands upright.
    const bar = shape({ w: 100, h: 10, rotation: Math.PI / 2 });
    expect(hitShape(bar, { x: 50, y: 50 }, 0)).toBe(true);
    expect(hitShape(bar, { x: 90, y: 5 }, 0)).toBe(false);
  });

  it("hits a line within the tolerance only", () => {
    const line = shape({ type: "line", w: 100, h: 100 });
    expect(hitShape(line, { x: 50, y: 53 }, 4)).toBe(true);
    expect(hitShape(line, { x: 50, y: 70 }, 4)).toBe(false);
  });
});

describe("shapeBounds", () => {
  it("grows to contain a rotated shape", () => {
    const b = shapeBounds(shape({ rotation: Math.PI / 4 }));
    const half = Math.SQRT2 * 50;
    expect(b.minX).toBeCloseTo(50 - half);
    expect(b.maxX).toBeCloseTo(50 + half);
  });
});

describe("shapeIntersectsBox", () => {
  it("selects a diagonal line only when the box touches the line itself", () => {
    const line = shape({ type: "line", w: 100, h: 100 });
    expect(shapeIntersectsBox(line, { minX: 70, minY: 0, maxX: 100, maxY: 30 })).toBe(false);
    expect(shapeIntersectsBox(line, { minX: 40, minY: 40, maxX: 60, maxY: 60 })).toBe(true);
  });

  it("detects a box fully inside a shape", () => {
    expect(shapeIntersectsBox(shape({}), { minX: 40, minY: 40, maxX: 60, maxY: 60 })).toBe(true);
  });

  it("detects crossing edges with no corner inside either", () => {
    const plus = [
      { x: 40, y: -10 },
      { x: 60, y: -10 },
      { x: 60, y: 110 },
      { x: 40, y: 110 },
    ];
    expect(polygonIntersectsBox(plus, { minX: 0, minY: 40, maxX: 100, maxY: 60 })).toBe(true);
  });
});

describe("resizeCursor", () => {
  it("turns with the shape", () => {
    expect(resizeCursor("e", 0)).toBe("ew-resize");
    expect(resizeCursor("e", Math.PI / 2)).toBe("ns-resize");
    expect(resizeCursor("se", 0)).toBe("nwse-resize");
    expect(resizeCursor("nw", 0)).toBe("nwse-resize");
    expect(resizeCursor("ne", 0)).toBe("nesw-resize");
  });
});
