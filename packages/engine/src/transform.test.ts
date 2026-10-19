import type { Shape, ShapeId } from "@niro/doc";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createdGeometry } from "./interaction";
import { handleWorldPoint } from "./selection";
import { lineEnds } from "./shapes";
import {
  HANDLE_DIRECTIONS,
  type Handle,
  moveLineEnd,
  resizeBox,
  rotateAroundPivot,
  scaleAround,
} from "./transform";

const HANDLES = Object.keys(HANDLE_DIRECTIONS) as Handle[];

const box = (patch: Partial<Shape> = {}): Shape => ({
  id: "s1" as ShapeId,
  type: "rectangle",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  rotation: 0,
  parentId: null,
  index: "a0",
  color: "blue",
  text: "",
  ...patch,
});

const coord = fc.double({ min: -1000, max: 1000, noNaN: true });
const size = fc.double({ min: 5, max: 500, noNaN: true });
const angle = fc.double({ min: 0, max: Math.PI * 2 - 0.001, noNaN: true });
const boxes = fc
  .record({ x: coord, y: coord, w: size, h: size, rotation: angle })
  .map((p) => box(p));

const opposite = (h: Handle): Handle => {
  const d = HANDLE_DIRECTIONS[h];
  return HANDLES.find(
    (o) => HANDLE_DIRECTIONS[o].x === -d.x && HANDLE_DIRECTIONS[o].y === -d.y,
  ) as Handle;
};

const close = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);

describe("resizeBox", () => {
  it("leaves the shape unchanged when a handle is dropped where it started", () => {
    fc.assert(
      fc.property(boxes, fc.constantFrom(...HANDLES), (shape, handle) => {
        const at = handleWorldPoint({ kind: "box", shape }, handle);
        const patch = resizeBox(shape, handle, at, false);
        close(patch.x as number, shape.x);
        close(patch.y as number, shape.y);
        close(patch.w as number, shape.w);
        close(patch.h as number, shape.h);
      }),
    );
  });

  it("keeps the opposite handle fixed in world space, at any rotation", () => {
    fc.assert(
      fc.property(boxes, fc.constantFrom(...HANDLES), coord, coord, (shape, handle, px, py) => {
        const anchor = handleWorldPoint({ kind: "box", shape }, opposite(handle));
        const resized = { ...shape, ...resizeBox(shape, handle, { x: px, y: py }, false) };
        // When the drag flips the box on one or both axes, the fixed point
        // becomes a different handle of the new box, so check them all.
        const candidates = HANDLES.map((h) => handleWorldPoint({ kind: "box", shape: resized }, h));
        const hit = candidates.some(
          (c) => Math.abs(c.x - anchor.x) < 1e-6 && Math.abs(c.y - anchor.y) < 1e-6,
        );
        // Sizes clamped to the minimum can't keep the anchor exactly.
        if (resized.w > 1 && resized.h > 1) expect(hit).toBe(true);
      }),
    );
  });

  it("keeps the aspect ratio from a corner when asked", () => {
    fc.assert(
      fc.property(
        boxes,
        fc.constantFrom<Handle>("nw", "ne", "se", "sw"),
        coord,
        coord,
        (shape, handle, px, py) => {
          const patch = resizeBox(shape, handle, { x: px, y: py }, true);
          const w = patch.w as number;
          const h = patch.h as number;
          if (w > 1 && h > 1) close(w / h, shape.w / shape.h, 4);
        },
      ),
    );
  });

  it("drags the east edge of an unrotated box", () => {
    expect(resizeBox(box(), "e", { x: 180, y: 999 }, false)).toEqual({ x: 0, y: 0, w: 180, h: 50 });
  });
});

describe("rotateAroundPivot", () => {
  it("is undone by the opposite rotation", () => {
    fc.assert(
      fc.property(boxes, coord, coord, angle, (shape, px, py, delta) => {
        const pivot = { x: px, y: py };
        const turned = { ...shape, ...rotateAroundPivot(shape, pivot, delta) };
        const back = { ...turned, ...rotateAroundPivot(turned, pivot, -delta) };
        close(back.x, shape.x, 4);
        close(back.y, shape.y, 4);
        const diff = Math.abs(back.rotation - shape.rotation);
        expect(Math.min(diff, Math.PI * 2 - diff)).toBeLessThan(1e-6);
      }),
    );
  });

  it("rotates a line's end points instead of setting rotation", () => {
    const line = box({ type: "line", x: 0, y: 0, w: 100, h: 0 });
    const patch = rotateAroundPivot(line, { x: 0, y: 0 }, Math.PI / 2);
    expect(patch.rotation).toBeUndefined();
    close(patch.w as number, 0);
    close(patch.h as number, 100);
  });
});

describe("scaleAround", () => {
  it("keeps the anchor and scales sizes", () => {
    const patch = scaleAround(box({ x: 100, y: 100 }), { x: 0, y: 0 }, 2);
    expect(patch).toEqual({ x: 200, y: 200, w: 200, h: 100 });
  });
});

describe("moveLineEnd", () => {
  it("keeps the other end where it was", () => {
    fc.assert(
      fc.property(coord, coord, coord, coord, fc.boolean(), (x, y, px, py, snap) => {
        const line = box({ type: "line", x, y, w: 50, h: -30 });
        const [, end] = lineEnds(line);
        const moved = { ...line, ...moveLineEnd(line, "start", { x: px, y: py }, snap) };
        const [, endAfter] = lineEnds(moved);
        close(endAfter.x, end.x, 6);
        close(endAfter.y, end.y, 6);
      }),
    );
  });
});

describe("createdGeometry", () => {
  it("normalizes a box dragged up and to the left", () => {
    expect(createdGeometry("rectangle", { x: 100, y: 100 }, { x: 40, y: 70 }, false)).toEqual({
      x: 40,
      y: 70,
      w: 60,
      h: 30,
    });
  });

  it("makes sticky notes square", () => {
    const g = createdGeometry("sticky", { x: 0, y: 0 }, { x: 120, y: 40 }, false);
    expect(g.w).toBe(120);
    expect(g.h).toBe(120);
  });

  it("snaps lines to 15 degree steps when constrained", () => {
    const g = createdGeometry("line", { x: 0, y: 0 }, { x: 100, y: 8 }, true);
    close(g.h as number, 0);
    close(g.w as number, Math.hypot(100, 8));
  });
});
