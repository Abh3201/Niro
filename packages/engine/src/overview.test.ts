import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { fitOverview, overviewOf, overviewToWorld, worldToOverview } from "./overview";
import { LIGHT_PALETTE } from "./render";
import { Scene } from "./scene";
import { memoryDoc } from "./test-doc";

const shape = (id: string, patch: Partial<Shape> = {}): Shape => ({
  id: id as ShapeId,
  type: "rectangle",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
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

describe("overviewOf", () => {
  it("lists shapes bottom first with their colors, skips groups, and bounds them", () => {
    const scene = new Scene(
      memoryDoc([
        shape("frame", { type: "frame", color: "grey", w: 400, h: 300, index: "a0" }),
        shape("note", {
          type: "sticky",
          color: "yellow",
          x: 20,
          y: 20,
          parentId: "frame" as ShapeId,
        }),
        shape("group", { type: "group", w: 0, h: 0, index: "a1" }),
        shape("far", { x: 1000, y: -100, index: "a2" }),
      ]),
    );
    const overview = overviewOf(scene, LIGHT_PALETTE);
    expect(overview.items.map((i) => i.kind)).toEqual(["frame", "shape", "shape"]);
    expect(overview.items[1]?.fill).toBe(LIGHT_PALETTE.paper.yellow);
    expect(overview.bounds).toEqual({ minX: 0, minY: -100, maxX: 1100, maxY: 300 });
  });

  it("has no bounds for an empty board", () => {
    expect(overviewOf(new Scene(memoryDoc()), LIGHT_PALETTE).bounds).toBeNull();
  });
});

describe("fitOverview", () => {
  const view = { minX: 0, minY: 0, maxX: 200, maxY: 100 };

  it("fits the board and the view together, centered, and maps both ways", () => {
    const content = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
    const fit = fitOverview(content, view, 200, 100, 0);
    expect(fit.scale).toBeCloseTo(0.1);
    const corner = worldToOverview(fit, { x: 2000, y: 1000 });
    expect(corner.x).toBeCloseTo(200);
    expect(corner.y).toBeCloseTo(100);
    const back = overviewToWorld(fit, { x: 100, y: 50 });
    expect(back.x).toBeCloseTo(1000);
    expect(back.y).toBeCloseTo(500);
  });

  it("keeps the view inside when it is far from the shapes", () => {
    const far = { minX: 10_000, minY: 0, maxX: 10_200, maxY: 100 };
    const fit = fitOverview({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, far, 200, 100, 0);
    const right = worldToOverview(fit, { x: far.maxX, y: far.maxY });
    expect(right.x).toBeLessThanOrEqual(200 + 1e-6);
    expect(worldToOverview(fit, { x: 0, y: 0 }).x).toBeGreaterThanOrEqual(-1e-6);
  });

  it("handles an empty board", () => {
    const fit = fitOverview(null, view, 200, 100, 0);
    expect(fit.scale).toBeCloseTo(1);
  });
});
