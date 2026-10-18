import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM } from "./camera";
import { drawGrid, GRID_SPACING, gridSpacing, MIN_DOT_GAP } from "./grid";

describe("gridSpacing", () => {
  it("uses the base spacing at 100%", () => {
    expect(gridSpacing(1)).toBe(GRID_SPACING);
  });

  it("doubles the spacing when dots would get too dense", () => {
    expect(gridSpacing(0.4)).toBe(GRID_SPACING * 2);
    expect(gridSpacing(0.25)).toBe(GRID_SPACING * 2);
    expect(gridSpacing(0.2)).toBe(GRID_SPACING * 4);
  });

  it("keeps dots at least MIN_DOT_GAP apart on screen across the zoom range", () => {
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom *= 1.07) {
      const gap = gridSpacing(zoom) * zoom;
      expect(gap).toBeGreaterThanOrEqual(MIN_DOT_GAP);
      // ...and never more than twice that, unless already at the base spacing.
      if (gridSpacing(zoom) > GRID_SPACING) expect(gap).toBeLessThan(MIN_DOT_GAP * 2);
    }
  });
});

describe("drawGrid", () => {
  const dots = (x: number, y: number) => {
    let count = 0;
    const ctx = {
      clearRect() {},
      beginPath() {},
      fill() {},
      fillStyle: "",
      rect() {
        count++;
      },
    } as unknown as CanvasRenderingContext2D;
    drawGrid(ctx, { x, y, zoom: 1 }, { width: 240, height: 120 }, "#000");
    return count;
  };

  it("draws one dot per grid point in view", () => {
    expect(dots(0, 0)).toBe(11 * 6);
  });

  it("returns far from the origin, where adding the spacing no longer moves x", () => {
    expect(1e20 + GRID_SPACING).toBe(1e20);
    expect(dots(1e20, 1e20)).toBeLessThanOrEqual(11 * 6);
  });
});
