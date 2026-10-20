import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { resolveArrow } from "./arrows";
import { ELBOW_CLEARANCE, linePoints, type RouteEnd, routeElbow } from "./elbow";
import { exportSvg } from "./export";
import type { Box, Point } from "./geometry";
import { LIGHT_PALETTE } from "./render";
import { Scene } from "./scene";
import { hitShape, shapeBounds, shapeIntersectsBox } from "./shapes";
import { memoryDoc } from "./test-doc";
import { TextLayouts } from "./text";

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

const free = (x: number, y: number): RouteEnd => ({
  point: { x, y },
  heading: null,
  obstacle: null,
});

const orthogonal = (path: readonly Point[]) =>
  path.every((p, i) => {
    const q = path[i + 1];
    return !q || Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6;
  });

const turns = (path: readonly Point[]) => path.length - 2;

/** True when no part of the path goes through the inside of `box`. */
function avoids(path: readonly Point[], box: Box): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as Point;
    const b = path[i + 1] as Point;
    for (let t = 0; t <= 1; t += 0.01) {
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (x > box.minX + 1e-6 && x < box.maxX - 1e-6 && y > box.minY + 1e-6 && y < box.maxY - 1e-6)
        return false;
    }
  }
  return true;
}

describe("routeElbow", () => {
  it("joins two free ends with a single turn, using only right angles", () => {
    const path = routeElbow(free(0, 0), free(200, 120));
    expect(orthogonal(path)).toBe(true);
    expect(turns(path)).toBe(1);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path.at(-1)).toEqual({ x: 200, y: 120 });
  });

  it("is a straight line between ends in a row", () => {
    expect(routeElbow(free(0, 50), free(300, 50))).toEqual([
      { x: 0, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it("runs straight between facing sides at the same height", () => {
    const a: Box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const b: Box = { minX: 400, minY: 0, maxX: 500, maxY: 100 };
    const path = routeElbow(
      { point: { x: 108, y: 50 }, heading: { x: 1, y: 0 }, obstacle: a },
      { point: { x: 392, y: 50 }, heading: { x: -1, y: 0 }, obstacle: b },
    );
    expect(path).toEqual([
      { x: 108, y: 50 },
      { x: 392, y: 50 },
    ]);
  });

  it("steps over to a shape above and to the right with two turns, leaving and entering at right angles", () => {
    const a: Box = { minX: 0, minY: 200, maxX: 100, maxY: 300 };
    const b: Box = { minX: 400, minY: 0, maxX: 500, maxY: 100 };
    const path = routeElbow(
      { point: { x: 108, y: 250 }, heading: { x: 1, y: 0 }, obstacle: a },
      { point: { x: 392, y: 50 }, heading: { x: -1, y: 0 }, obstacle: b },
    );
    expect(orthogonal(path)).toBe(true);
    expect(turns(path)).toBe(2);
    // Out of A to the right, into B from the left.
    expect((path[1] as Point).y).toBe(250);
    expect((path.at(-2) as Point).y).toBe(50);
  });

  it("goes around the shapes when the arrow has to leave away from the target", () => {
    const a: Box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const b: Box = { minX: -300, minY: 0, maxX: -200, maxY: 100 };
    const path = routeElbow(
      // Leaves A to the right, and must come into B's right side from the right.
      { point: { x: 108, y: 50 }, heading: { x: 1, y: 0 }, obstacle: a },
      { point: { x: -192, y: 50 }, heading: { x: 1, y: 0 }, obstacle: b },
    );
    expect(orthogonal(path)).toBe(true);
    expect(avoids(path, a)).toBe(true);
    expect(avoids(path, b)).toBe(true);
    expect(path.length).toBeGreaterThan(3);
    // It rounds A at a distance, over the top or under the bottom.
    const ys = path.map((p) => p.y);
    expect(
      Math.min(...ys) <= -ELBOW_CLEARANCE + 1e-6 || Math.max(...ys) >= 100 + ELBOW_CLEARANCE - 1e-6,
    ).toBe(true);
  });

  it("falls back to a plain Z when the ends are inside each other's clearance", () => {
    const a: Box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const b: Box = { minX: 90, minY: 0, maxX: 190, maxY: 100 };
    const path = routeElbow(
      { point: { x: 108, y: 50 }, heading: { x: 1, y: 0 }, obstacle: a },
      { point: { x: 82, y: 50 }, heading: { x: -1, y: 0 }, obstacle: b },
    );
    expect(orthogonal(path)).toBe(true);
  });
});

describe("elbow arrows", () => {
  const boxes = [shape("a", { x: 0, y: 200 }), shape("b", { x: 400, y: 0 })];
  const arrow = (patch: Partial<Shape> = {}) =>
    shape("arrow", {
      type: "arrow",
      color: "black",
      route: "elbow",
      from: "a" as ShapeId,
      to: "b" as ShapeId,
      w: 0,
      h: 0,
      ...patch,
    });
  const scene = () => new Scene(memoryDoc([...boxes, arrow()]));

  it("attaches to the sides of its shapes and is drawn with right angles", () => {
    const drawn = scene().get("arrow" as ShapeId) as Shape;
    const path = linePoints(drawn);
    expect(orthogonal(path)).toBe(true);
    expect(path.length).toBeGreaterThan(2);
    // Starts just right of A's right side (x 100 + 8), ends just left of B (x 400 - 8).
    expect(path[0]).toEqual({ x: 108, y: 250 });
    expect(path.at(-1)).toEqual({ x: 392, y: 50 });
    expect(drawn).toMatchObject({ x: 108, y: 250, w: 284, h: -200 });
  });

  it("follows its shapes when they move", () => {
    const s = new Scene(memoryDoc([...boxes, arrow()]));
    const moved = resolveArrow(arrow(), (id) =>
      id === "b" ? shape("b", { x: 400, y: 600 }) : boxes.find((b) => b.id === id),
    );
    const path = linePoints(moved);
    expect(path.at(-1)).toEqual({ x: 392, y: 650 });
    expect(orthogonal(path)).toBe(true);
    expect(s.size).toBe(3);
  });

  it("is hit along its bends and not across its corner", () => {
    const drawn = scene().get("arrow" as ShapeId) as Shape;
    const path = linePoints(drawn);
    const mid = path[1] as Point;
    expect(hitShape(drawn, mid, 4)).toBe(true);
    // The straight chord between the ends isn't the arrow.
    const chord = { x: (108 + 392) / 2 + 30, y: (250 + 50) / 2 - 30 };
    expect(hitShape(drawn, chord, 4)).toBe(false);
    const box = shapeBounds(drawn);
    expect(box.minX).toBeLessThanOrEqual(108);
    expect(
      shapeIntersectsBox(drawn, {
        minX: mid.x - 2,
        minY: mid.y - 2,
        maxX: mid.x + 2,
        maxY: mid.y + 2,
      }),
    ).toBe(true);
  });

  it("is routed between its ends when it isn't attached", () => {
    const drawn = shape("free", { type: "arrow", route: "elbow", x: 0, y: 0, w: 200, h: 100 });
    const path = linePoints(drawn);
    expect(orthogonal(path)).toBe(true);
    expect(turns(path)).toBe(1);
  });

  it("is exported as a path with several segments and rounded joins", () => {
    const layouts = new TextLayouts((t) => t.length * 0.5);
    const svg = exportSvg({
      scene: scene(),
      ids: null,
      palette: LIGHT_PALETTE,
      background: "#ffffff",
      baseline: 0.8,
      textLayout: (s) => (s.text === "" ? undefined : layouts.get(s)),
      stroke: () => undefined,
    });
    expect(svg).toContain('stroke-linejoin="round"');
  });
});
