import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM } from "./camera";
import { GRID_SPACING, gridSpacing, MIN_DOT_GAP } from "./grid";

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
