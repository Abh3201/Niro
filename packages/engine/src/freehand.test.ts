import { POINT_SCALE, PRESSURE_SCALE, type Shape, type ShapeId } from "@niro/doc";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  hitStroke,
  localPenPoints,
  PEN_SIZE,
  type PenPoint,
  strokeOutline,
  strokeShape,
} from "./freehand";
import { boxFromPoints, type Point } from "./geometry";
import { shapeCenter } from "./shapes";

const stroke = (points: readonly PenPoint[], patch: Partial<Shape> = {}): Shape => ({
  id: "f1" as ShapeId,
  type: "freehand",
  rotation: 0,
  parentId: null,
  index: "a0",
  color: "black",
  text: "",
  from: null,
  to: null,
  ...strokeShape(points),
  ...patch,
});

/** Where a stroke's stored points are on the board, unrotated. */
const worldPoints = (shape: Shape) => {
  const c = shapeCenter(shape);
  return localPenPoints(shape).map((p) => ({ ...p, x: p.x + c.x, y: p.y + c.y }));
};

describe("strokeShape", () => {
  it("stores points across a box with room for the stroke's thickness", () => {
    const shape = stroke([
      { x: 10, y: 20, pressure: 0.5 },
      { x: 110, y: 20, pressure: 1 },
    ]);
    const pad = PEN_SIZE / 2 + 1;
    expect(shape).toMatchObject({ x: 10 - pad, y: 20 - pad, w: 100 + 2 * pad, h: 2 * pad });
    expect(shape.points).toHaveLength(6);
    for (const [i, value] of shape.points.entries()) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(i % 3 === 2 ? PRESSURE_SCALE : POINT_SCALE);
    }
    expect(shape.points[2]).toBe(50);
    expect(shape.points[5]).toBe(100);
  });

  it("gives back the points it was given, to within rounding", () => {
    const point = fc.record({
      x: fc.double({ min: -1e5, max: 1e5, noNaN: true }),
      y: fc.double({ min: -1e5, max: 1e5, noNaN: true }),
      pressure: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(point, { minLength: 1, maxLength: 50 }), (points) => {
        const shape = stroke(points);
        const back = worldPoints(shape);
        // Rounding to 1/10000 of the box.
        const slack = Math.max(shape.w, shape.h) / POINT_SCALE;
        for (const [i, p] of points.entries()) {
          expect(Math.abs((back[i]?.x ?? Number.NaN) - p.x)).toBeLessThanOrEqual(slack);
          expect(Math.abs((back[i]?.y ?? Number.NaN) - p.y)).toBeLessThanOrEqual(slack);
          expect(Math.abs((back[i]?.pressure ?? Number.NaN) - p.pressure)).toBeLessThanOrEqual(
            0.5 / PRESSURE_SCALE + 1e-9,
          );
        }
      }),
    );
  });

  it("stretches its points with its box", () => {
    const shape = stroke([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 100, y: 100, pressure: 0.5 },
    ]);
    const wider = localPenPoints({ ...shape, w: shape.w * 2 });
    const original = localPenPoints(shape);
    expect(wider[1]?.x).toBeCloseTo((original[1]?.x ?? 0) * 2);
    expect(wider[1]?.y).toBeCloseTo(original[1]?.y ?? 0);
  });
});

describe("strokeOutline", () => {
  const line = (pressure: (i: number) => number) =>
    Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: 0, pressure: pressure(i) }));
  const thickness = (outline: readonly Point[]) =>
    boxFromPoints(outline).maxY - boxFromPoints(outline).minY;

  it("surrounds the points, about as thick as the pen", () => {
    const outline = strokeOutline(line(() => 0.5));
    expect(outline.length).toBeGreaterThan(10);
    const box = boxFromPoints(outline);
    expect(box.minX).toBeLessThanOrEqual(0);
    expect(box.maxX).toBeGreaterThanOrEqual(190);
    expect(thickness(outline)).toBeGreaterThan(PEN_SIZE * 0.3);
    expect(thickness(outline)).toBeLessThanOrEqual(PEN_SIZE * 1.5);
  });

  it("thickens with pressure when the pen senses it", () => {
    const light = strokeOutline(line((i) => (i % 2 === 0 ? 0.1 : 0.15)));
    const heavy = strokeOutline(line((i) => (i % 2 === 0 ? 0.9 : 0.95)));
    expect(thickness(heavy)).toBeGreaterThan(thickness(light) * 1.5);
  });

  it("draws a dot for a click, and nothing for no points", () => {
    expect(strokeOutline([{ x: 5, y: 5, pressure: 0.5 }]).length).toBeGreaterThan(3);
    expect(strokeOutline([])).toEqual([]);
  });
});

describe("hitStroke", () => {
  const vee = stroke([
    { x: 0, y: 0, pressure: 0.5 },
    { x: 50, y: 100, pressure: 0.5 },
    { x: 100, y: 0, pressure: 0.5 },
  ]);
  const local = (x: number, y: number) => {
    const c = shapeCenter(vee);
    return { x: x - c.x, y: y - c.y };
  };

  it("hits the ink, not the empty middle of its box", () => {
    expect(hitStroke(vee, local(25, 50), 2)).toBe(true);
    expect(hitStroke(vee, local(50, 98), 2)).toBe(true);
    expect(hitStroke(vee, local(50, 30), 2)).toBe(false);
  });

  it("hits a dot around its point", () => {
    const dot = stroke([{ x: 10, y: 10, pressure: 0.5 }]);
    expect(hitStroke(dot, { x: 0, y: 0 }, 0)).toBe(true);
    expect(hitStroke(dot, { x: PEN_SIZE, y: 0 }, 1)).toBe(false);
  });
});
