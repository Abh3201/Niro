import type { Shape, ShapeId } from "@niro/doc";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { benchmarkBoard } from "./bench-board";
import { transact } from "./board-tx";
import type { Box, Point } from "./geometry";
import { Scene } from "./scene";
import { hitShape, shapeExtent, shapeIntersectsBox, toShapeFrame } from "./shapes";
import { memoryDoc } from "./test-doc";

/*
 * The scene answers "what's here?" from an R-tree. These tests check it
 * answers exactly what scanning every shape, as it did before the index,
 * would: on a realistic board (frames, groups, arrows, strokes, turned
 * shapes), after random moves, deletions and changes of frame.
 */

const inside = (shape: Shape, p: Point) => {
  const local = toShapeFrame(shape, p);
  return Math.abs(local.x) <= shape.w / 2 && Math.abs(local.y) <= shape.h / 2;
};

const visibleAt = (scene: Scene, id: ShapeId, p: Point) =>
  scene.framesAround(id).every((frameId) => {
    const frame = scene.get(frameId);
    return !frame || inside(frame, p);
  });

/** `Scene.hit` as it was: every shape, topmost first. */
function scanHit(scene: Scene, p: Point, tolerance: number): Shape | undefined {
  const order = scene.ordered();
  for (let i = order.length - 1; i >= 0; i--) {
    const shape = order[i] as Shape;
    if (hitShape(shape, p, tolerance)) {
      if (visibleAt(scene, shape.id, p)) return shape;
    } else if (shape.type === "frame" && inside(shape, p) && visibleAt(scene, shape.id, p)) {
      return undefined;
    }
  }
  return undefined;
}

function scanFrameAt(scene: Scene, p: Point): ShapeId | null {
  const order = scene.ordered();
  for (let i = order.length - 1; i >= 0; i--) {
    const shape = order[i] as Shape;
    if (shape.type === "frame" && inside(shape, p) && visibleAt(scene, shape.id, p))
      return shape.id;
  }
  return null;
}

const overlaps = (a: Box, b: Box) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

const ids = (shapes: readonly Shape[]) => shapes.map((s) => s.id);

const edit = fc.record({
  kind: fc.constantFrom("move", "move", "remove", "rehome"),
  pick: fc.nat(),
  dx: fc.integer({ min: -3_000, max: 3_000 }),
  dy: fc.integer({ min: -3_000, max: 3_000 }),
});

const probe = fc.record({
  pick: fc.nat(),
  dx: fc.integer({ min: -150, max: 150 }),
  dy: fc.integer({ min: -150, max: 150 }),
  size: fc.integer({ min: 0, max: 2_000 }),
  tolerance: fc.constantFrom(0, 4, 40),
});

describe("Scene spatial index", () => {
  it("finds what scanning every shape finds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.array(edit, { maxLength: 15 }),
        fc.array(probe, { minLength: 1, maxLength: 25 }),
        (seed, edits, probes) => {
          const doc = memoryDoc(benchmarkBoard(400, seed));
          const scene = new Scene(doc);
          doc.subscribe((changes) => scene.apply(changes));
          const nth = (n: number) => scene.ordered()[n % scene.size] as Shape;

          for (const e of edits) {
            if (scene.size === 0) break;
            const target = nth(e.pick);
            transact(doc, scene, (tx) => {
              if (e.kind === "remove") tx.remove(target.id);
              else if (e.kind === "move")
                tx.update(target.id, { x: target.x + e.dx, y: target.y + e.dy });
              else {
                const frames = scene.ordered().filter((s) => s.type === "frame");
                const frame = frames[e.pick % Math.max(1, frames.length)];
                tx.update(target.id, {
                  parentId: frame && frame.id !== target.id ? frame.id : null,
                });
              }
            });
          }
          if (scene.size === 0) return;

          for (const q of probes) {
            const near = nth(q.pick);
            const p = { x: near.x + near.w / 2 + q.dx, y: near.y + near.h / 2 + q.dy };
            expect(scene.hit(p, q.tolerance)?.id).toBe(scanHit(scene, p, q.tolerance)?.id);
            expect(scene.frameAt(p)).toBe(scanFrameAt(scene, p));
            const box = { minX: p.x, minY: p.y, maxX: p.x + q.size, maxY: p.y + q.size * 0.6 };
            expect(ids(scene.inBox(box))).toEqual(
              ids(scene.ordered().filter((s) => shapeIntersectsBox(s, box))),
            );
            expect(ids(scene.visible(box))).toEqual(
              ids(scene.ordered().filter((s) => overlaps(shapeExtent(s), box))),
            );
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("keeps shapes it doesn't draw out of view, and draws the rest in order", () => {
    const doc = memoryDoc(benchmarkBoard(2_000, 7));
    const scene = new Scene(doc);
    const order = ids(scene.ordered());
    const view = { minX: 0, minY: 0, maxX: 3_000, maxY: 2_000 };
    const visible = ids(scene.visible(view));
    expect(visible.length).toBeGreaterThan(50);
    expect(visible.length).toBeLessThan(order.length / 4);
    // Draw order is kept: the visible shapes are a subsequence of all of them.
    const positions = visible.map((id) => order.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
