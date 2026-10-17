import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Camera, screenToWorld } from "./camera";
import { midpoint, type Point } from "./geometry";
import { pinchCamera } from "./gestures";

const p = (x: number, y: number): Point => ({ x, y });
const cam: Camera = { x: 0, y: 0, zoom: 1 };

describe("pinchCamera", () => {
  it("zooms by the change in finger spread", () => {
    const next = pinchCamera(cam, [p(100, 100), p(200, 100)], [p(50, 100), p(250, 100)]);
    expect(next.zoom).toBeCloseTo(2);
  });

  it("pans by the midpoint's movement when the spread is unchanged", () => {
    const next = pinchCamera(cam, [p(100, 100), p(200, 100)], [p(130, 140), p(230, 140)]);
    expect(next).toEqual({ x: -30, y: -40, zoom: 1 });
  });

  it("keeps the world point between the fingers between the fingers", () => {
    const point = fc.record({
      x: fc.double({ min: 0, max: 2000, noNaN: true }),
      y: fc.double({ min: 0, max: 2000, noNaN: true }),
    });
    fc.assert(
      fc.property(point, point, point, point, (a, b, c, d) => {
        fc.pre(Math.hypot(a.x - b.x, a.y - b.y) > 10);
        const spread = Math.hypot(c.x - d.x, c.y - d.y) / Math.hypot(a.x - b.x, a.y - b.y);
        fc.pre(spread > 0.1 && spread < 4); // stay inside the zoom limits
        const before = screenToWorld(cam, midpoint(a, b));
        const after = screenToWorld(pinchCamera(cam, [a, b], [c, d]), midpoint(c, d));
        return Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6;
      }),
    );
  });
});
