import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Camera,
  centerOn,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  nextZoomStep,
  panBy,
  screenToWorld,
  visibleBounds,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
} from "./camera";

const coord = fc.double({ min: -1e6, max: 1e6, noNaN: true });
const screenCoord = fc.double({ min: 0, max: 4000, noNaN: true });
const zoom = fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true });
const camera = fc.record({ x: coord, y: coord, zoom });
const screenPoint = fc.record({ x: screenCoord, y: screenCoord });

function close(a: number, b: number, scale = 1) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(scale));
}

describe("screen and world conversion", () => {
  it("are inverses of each other", () => {
    fc.assert(
      fc.property(camera, screenPoint, (cam, p) => {
        const back = worldToScreen(cam, screenToWorld(cam, p));
        return close(back.x, p.x, 1e6 * cam.zoom) && close(back.y, p.y, 1e6 * cam.zoom);
      }),
    );
  });

  it("puts the camera position at the top-left corner of the screen", () => {
    expect(worldToScreen({ x: 10, y: 20, zoom: 2 }, { x: 10, y: 20 })).toEqual({ x: 0, y: 0 });
    expect(worldToScreen({ x: 10, y: 20, zoom: 2 }, { x: 11, y: 20 })).toEqual({ x: 2, y: 0 });
  });
});

describe("zoomAt", () => {
  it("keeps the world point under the cursor fixed", () => {
    fc.assert(
      fc.property(camera, screenPoint, zoom, (cam, p, z) => {
        const before = screenToWorld(cam, p);
        const after = screenToWorld(zoomAt(cam, p, z), p);
        return close(before.x, after.x, before.x) && close(before.y, after.y, before.y);
      }),
    );
  });

  it("clamps to the allowed zoom range", () => {
    const cam: Camera = { x: 0, y: 0, zoom: 1 };
    expect(zoomAt(cam, { x: 0, y: 0 }, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, { x: 0, y: 0 }, 0).zoom).toBe(MIN_ZOOM);
  });
});

describe("panBy", () => {
  it("moves content by exactly the pointer distance at any zoom", () => {
    fc.assert(
      fc.property(camera, screenPoint, coord, coord, (cam, p, dx, dy) => {
        const world = screenToWorld(cam, p);
        const moved = worldToScreen(panBy(cam, dx, dy), world);
        const scale = Math.abs(world.x) + Math.abs(world.y) + 1e6;
        return (
          close(moved.x, p.x + dx, scale * cam.zoom) && close(moved.y, p.y + dy, scale * cam.zoom)
        );
      }),
    );
  });
});

describe("centerOn and visibleBounds", () => {
  it("shows the requested point in the middle of the viewport", () => {
    const viewport = { width: 800, height: 600 };
    const cam = centerOn({ x: 100, y: -50 }, viewport, 2);
    expect(worldToScreen(cam, { x: 100, y: -50 })).toEqual({ x: 400, y: 300 });
    expect(visibleBounds(cam, viewport)).toEqual({ minX: -100, minY: -200, maxX: 300, maxY: 100 });
  });
});

describe("zoom steps", () => {
  it("steps through the preset levels and stops at the limits", () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
    expect(nextZoomStep(1.1, -1)).toBe(1);
    expect(nextZoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(nextZoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("clamps arbitrary values", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(-1)).toBe(MIN_ZOOM);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on negative deltas and out on positive ones", () => {
    expect(wheelZoomFactor(-10, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10, 0)).toBeLessThan(1);
  });

  it("returns to the starting zoom after equal and opposite deltas", () => {
    expect(wheelZoomFactor(-30, 0) * wheelZoomFactor(30, 0)).toBeCloseTo(1, 12);
  });

  it("treats line-based deltas as roughly 16px per line and caps huge jumps", () => {
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(wheelZoomFactor(16, 0), 12);
    expect(wheelZoomFactor(10_000, 0)).toBeCloseTo(Math.exp(-1), 12);
  });
});
