import { describe, expect, it } from "vitest";
import { backingStoreSize } from "./canvas";

describe("backingStoreSize", () => {
  it("matches the CSS size on a 1x screen", () => {
    expect(backingStoreSize(800, 600, 1)).toEqual({ width: 800, height: 600 });
  });

  it("doubles the pixels on a 2x screen", () => {
    expect(backingStoreSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  });

  it("rounds fractional sizes to whole device pixels", () => {
    expect(backingStoreSize(333.5, 100.25, 1.5)).toEqual({ width: 500, height: 150 });
  });
});
