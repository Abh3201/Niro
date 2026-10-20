import { describe, expect, it } from "vitest";
import type { Box } from "./geometry";
import { snapBox } from "./snapping";

const box = (minX: number, minY: number, w = 10, h = 10): Box => ({
  minX,
  minY,
  maxX: minX + w,
  maxY: minY + h,
});

describe("snapBox", () => {
  it("lines up left edges, and draws a guide across both", () => {
    const snap = snapBox(box(102, 300, 7, 10), [box(100, 0, 40, 10)], 6);
    expect(snap.dx).toBe(-2);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toEqual([{ axis: "x", at: 100, from: 0, to: 310 }]);
  });

  it("lines up centers, and an edge to the other's far edge", () => {
    expect(snapBox(box(52, 0, 20, 10), [box(40, 100, 40, 10)], 6).dx).toBe(-2); // centers 62 -> 60
    expect(snapBox(box(83, 0), [box(40, 100, 40, 10)], 6).dx).toBe(-3); // left edge to right edge 80
  });

  it("takes the closest of several, and nothing beyond the tolerance", () => {
    expect(snapBox(box(105, 0, 4), [box(100, 50, 1), box(103, 90, 1)], 6).dx).toBe(-1);
    expect(snapBox(box(120, 0), [box(100, 50)], 6)).toMatchObject({ dx: 0, guides: [] });
  });

  it("snaps both axes, and joins every shape sharing the line", () => {
    const snap = snapBox(box(101, 201), [box(100, 0), box(100, 400), box(300, 200)], 6);
    expect([snap.dx, snap.dy]).toEqual([-1, -1]);
    const x = snap.guides.find((g) => g.axis === "x");
    expect(x).toMatchObject({ at: 100, from: 0, to: 410 });
    expect(snap.guides.some((g) => g.axis === "y" && g.at === 200)).toBe(true);
  });

  it("leaves a locked axis alone", () => {
    const snap = snapBox(box(101, 201), [box(100, 200)], 6, { x: false, y: true });
    expect([snap.dx, snap.dy]).toEqual([0, -1]);
  });
});
