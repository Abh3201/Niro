import type { Shape, ShapeId } from "@niro/doc";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ATTACH_GAP, asDrawn, detachUnless, outlineDistance, resolveArrow } from "./arrows";
import { hitShape, lineEnds, shapeCenter } from "./shapes";

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

const arrow = (patch: Partial<Shape> = {}) =>
  shape("arrow", { type: "arrow", x: 0, y: 0, w: 10, h: 10, color: "black", ...patch });

const board = (...shapes: Shape[]) => {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  return (id: ShapeId) => byId.get(id);
};

describe("outlineDistance", () => {
  it("is how far a box's or an ellipse's outline is from its center", () => {
    const box = shape("a", { w: 200, h: 100 });
    expect(outlineDistance(box, { x: 1, y: 0 })).toBeCloseTo(100);
    expect(outlineDistance(box, { x: 0, y: -1 })).toBeCloseTo(50);
    expect(outlineDistance(box, { x: Math.SQRT1_2, y: Math.SQRT1_2 })).toBeCloseTo(50 * Math.SQRT2);
    const ellipse = shape("e", { type: "ellipse", w: 200, h: 100 });
    expect(outlineDistance(ellipse, { x: Math.SQRT1_2, y: Math.SQRT1_2 })).toBeCloseTo(
      1 / Math.hypot(Math.SQRT1_2 / 100, Math.SQRT1_2 / 50),
    );
  });

  it("turns with the shape", () => {
    const turned = shape("a", { w: 200, h: 100, rotation: Math.PI / 2 });
    expect(outlineDistance(turned, { x: 1, y: 0 })).toBeCloseTo(50);
    expect(outlineDistance(turned, { x: 0, y: 1 })).toBeCloseTo(100);
  });
});

describe("resolveArrow", () => {
  const left = shape("left", { x: 0, y: 0, w: 100, h: 100 });
  const right = shape("right", { x: 300, y: 0, w: 100, h: 100 });

  it("runs between the outlines of the shapes it's attached to, leaving a gap", () => {
    const resolved = resolveArrow(arrow({ from: left.id, to: right.id }), board(left, right));
    expect(resolved).toMatchObject({ x: 100 + ATTACH_GAP, y: 50, h: 0 });
    expect(resolved.x + resolved.w).toBeCloseTo(300 - ATTACH_GAP);
  });

  it("keeps a free end where it's stored and points the attached end at it", () => {
    const resolved = resolveArrow(arrow({ x: 50, y: 400, w: 0, h: 0, to: left.id }), board(left));
    expect(resolved.x).toBe(50);
    expect(resolved.y).toBe(400);
    // The end comes up to just below the box's bottom edge.
    expect(resolved.x + resolved.w).toBeCloseTo(50);
    expect(resolved.y + resolved.h).toBeCloseTo(100 + ATTACH_GAP);
  });

  it("follows a turned ellipse's outline", () => {
    const ellipse = shape("e", {
      type: "ellipse",
      x: 300,
      y: -50,
      w: 100,
      h: 200,
      rotation: Math.PI / 2,
    });
    const resolved = resolveArrow(arrow({ from: left.id, to: ellipse.id }), board(left, ellipse));
    // Turned a quarter, the ellipse is 200 wide: its left edge is at 250.
    expect(resolved.x + resolved.w).toBeCloseTo(250 - ATTACH_GAP);
  });

  it("ends attached to shapes that are gone stay where they were stored", () => {
    const stored = arrow({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      from: "gone" as ShapeId,
      to: "lost" as ShapeId,
    });
    expect(resolveArrow(stored, board())).toBe(stored);
  });

  it("never attaches to lines, arrows, or itself", () => {
    const line = shape("line", { type: "line", x: 300, y: 0, w: 100, h: 0 });
    const stored = arrow({ x: 1, y: 2, w: 3, h: 4, from: line.id });
    expect(resolveArrow(stored, board(line))).toBe(stored);
    const self = arrow({ from: "arrow" as ShapeId });
    expect(resolveArrow(self, board(self))).toBe(self);
  });

  it("runs center to center between shapes too close for a gap", () => {
    const near = shape("near", { x: 90, y: 0 });
    const resolved = resolveArrow(arrow({ from: left.id, to: near.id }), board(left, near));
    expect(resolved).toMatchObject({ x: 50, y: 50, w: 90, h: 0 });
  });

  it("leaves other shapes alone", () => {
    const line = shape("l", { type: "line", from: left.id } as Partial<Shape>);
    expect(resolveArrow(line, board(left))).toBe(line);
  });

  it("always places attached ends just outside their shapes", () => {
    const box = fc.record({
      x: fc.integer({ min: -500, max: 500 }),
      y: fc.integer({ min: -500, max: 500 }),
      w: fc.integer({ min: 1, max: 300 }),
      h: fc.integer({ min: 1, max: 300 }),
      rotation: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true, maxExcluded: true }),
      type: fc.constantFrom<Shape["type"]>("rectangle", "ellipse", "sticky"),
    });
    fc.assert(
      fc.property(box, box, (a, b) => {
        const from = shape("from", a);
        const to = shape("to", b);
        const resolved = resolveArrow(arrow({ from: from.id, to: to.id }), board(from, to));
        const [start, end] = lineEnds(resolved);
        const close = (p: { x: number; y: number }, q: { x: number; y: number }) =>
          Math.hypot(p.x - q.x, p.y - q.y) < 1e-6;
        // Shapes too close for a gap: center to center.
        if (close(start, shapeCenter(from)) && close(end, shapeCenter(to))) return;
        for (const [point, target] of [
          [start, from],
          [end, to],
        ] as const) {
          // Outside the shape, and no further than the gap (a little more,
          // for an ellipse's widened outline).
          expect(hitShape(target, point, 0)).toBe(false);
          expect(hitShape(target, point, ATTACH_GAP * 1.5)).toBe(true);
        }
      }),
    );
  });
});

describe("detachUnless", () => {
  it("lets go of the shapes that aren't kept", () => {
    const a = arrow({ from: "s1" as ShapeId, to: "s2" as ShapeId });
    expect(detachUnless(a, (id) => id === "s1")).toEqual({ to: null });
    expect(detachUnless(a, () => true)).toEqual({});
    expect(detachUnless(a, () => false)).toEqual({ from: null, to: null });
    expect(detachUnless(shape("r"), () => false)).toEqual({});
  });
});

describe("asDrawn", () => {
  it("is an attached arrow's geometry, and nothing for anything else", () => {
    const a = arrow({ x: 1, y: 2, w: 3, h: 4, to: "s1" as ShapeId });
    expect(asDrawn(a)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(asDrawn(arrow())).toEqual({});
    expect(asDrawn(shape("r"))).toEqual({});
  });
});
