import { describe, expect, it } from "vitest";
import { easeCamera, followCamera } from "./follow";
import { LASER_LIFETIME_MS, LaserTrails, laserAlpha } from "./laser";

describe("followCamera", () => {
  it("fits the whole view, centered", () => {
    // A wide view on a square screen: width decides the zoom.
    const camera = followCamera({ x: 100, y: 100, w: 400, h: 200 }, { width: 800, height: 800 });
    expect(camera).toEqual({ x: 100, y: 100 + 100 - 200, zoom: 2 });
  });

  it("keeps a view that fills the screen as it is, and refuses an empty one", () => {
    expect(followCamera({ x: 5, y: 6, w: 800, h: 600 }, { width: 800, height: 600 })).toEqual({
      x: 5,
      y: 6,
      zoom: 1,
    });
    expect(followCamera({ x: 0, y: 0, w: 0, h: 5 }, { width: 800, height: 600 })).toBeNull();
    expect(followCamera({ x: 0, y: 0, w: 5, h: 5 }, { width: 0, height: 600 })).toBeNull();
  });
});

describe("easeCamera", () => {
  it("closes on the target and lands on it", () => {
    const to = { x: 100, y: 0, zoom: 2 };
    let camera = { x: 0, y: 0, zoom: 1 };
    const first = easeCamera(camera, to, 16);
    expect(first.x).toBeGreaterThan(0);
    expect(first.x).toBeLessThan(100);
    expect(first.zoom).toBeGreaterThan(1);
    for (let i = 0; i < 200; i++) camera = easeCamera(camera, to, 16);
    expect(camera).toEqual(to);
  });
});

describe("LaserTrails", () => {
  it("keeps points until they age out, and ignores a repeated point", () => {
    const trails = new LaserTrails();
    trails.add("me", { x: 0, y: 0 }, 0);
    trails.add("me", { x: 0, y: 0 }, 10);
    trails.add("me", { x: 5, y: 0 }, 500);
    trails.add(7, { x: 1, y: 1 }, 600);
    expect([...trails.entries()].map(([k, p]) => [k, p.length])).toEqual([
      ["me", 2],
      [7, 1],
    ]);
    expect(trails.step(LASER_LIFETIME_MS)).toBe(true);
    expect([...trails.entries()].map(([k, p]) => [k, p.length])).toEqual([
      ["me", 1],
      [7, 1],
    ]);
    expect(trails.step(LASER_LIFETIME_MS + 5000)).toBe(false);
  });

  it("fades from opaque to clear", () => {
    expect(laserAlpha(0)).toBe(1);
    expect(laserAlpha(LASER_LIFETIME_MS / 2)).toBeLessThan(1);
    expect(laserAlpha(LASER_LIFETIME_MS * 2)).toBe(0);
  });
});
