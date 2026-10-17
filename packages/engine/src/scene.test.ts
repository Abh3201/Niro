import type { DocStore, Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { Scene } from "./scene";

const shape = (id: string, index: string, x = 0): Shape => ({
  id: id as ShapeId,
  type: "rectangle",
  x,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  parentId: null,
  index,
  color: "blue",
  text: "",
  points: [],
  from: null,
  to: null,
});

const empty = { all: () => [] } as unknown as DocStore;
const ids = (scene: Scene) => scene.ordered().map((s) => s.id);

describe("Scene", () => {
  it("keeps draw order through moves, reorders and removals", () => {
    const scene = new Scene(empty);
    scene.apply([
      { kind: "added", shape: shape("b", "a1") },
      { kind: "added", shape: shape("a", "a0") },
    ]);
    expect(ids(scene)).toEqual(["a", "b"]);

    // A move keeps the order and shows the new position.
    scene.apply([{ kind: "updated", shape: shape("a", "a0", 50), previous: shape("a", "a0") }]);
    expect(ids(scene)).toEqual(["a", "b"]);
    expect(scene.ordered()[0]?.x).toBe(50);

    // A new index re-sorts.
    scene.apply([{ kind: "updated", shape: shape("a", "a2", 50), previous: shape("a", "a0", 50) }]);
    expect(ids(scene)).toEqual(["b", "a"]);

    scene.apply([{ kind: "removed", previous: shape("b", "a1") }]);
    expect(ids(scene)).toEqual(["a"]);
  });

  it("hits the topmost shape", () => {
    const scene = new Scene(empty);
    scene.apply([
      { kind: "added", shape: shape("low", "a0") },
      { kind: "added", shape: shape("high", "a1") },
    ]);
    expect(scene.hit({ x: 5, y: 5 }, 0)?.id).toBe("high");
    expect(scene.hit({ x: 50, y: 50 }, 0)).toBeUndefined();
  });

  it("draws an attached arrow where its shapes are now, following them as they move", () => {
    const scene = new Scene(empty);
    const arrow: Shape = {
      ...shape("arrow", "a2"),
      type: "arrow",
      x: -999,
      y: -999,
      w: 1,
      h: 1,
      from: "a" as ShapeId,
      to: "b" as ShapeId,
    };
    // The arrow can arrive before the shapes it's attached to.
    scene.apply([
      { kind: "added", shape: arrow },
      { kind: "added", shape: shape("a", "a0", 0) },
      { kind: "added", shape: shape("b", "a1", 100) },
    ]);
    expect(scene.get(arrow.id)).toMatchObject({ x: 18, y: 5, w: 74, h: 0 });
    expect(scene.arrowsAttachedTo("a" as ShapeId)).toEqual(["arrow"]);

    // Moving a shape moves the arrow, without the document changing it.
    scene.apply([
      { kind: "updated", shape: shape("b", "a1", 200), previous: shape("b", "a1", 100) },
    ]);
    expect(scene.get(arrow.id)).toMatchObject({ x: 18, w: 174 });
    expect(scene.ordered().find((s) => s.id === "arrow")?.w).toBe(174);

    // A shape that's gone leaves that end where it was stored; back, and it's attached again.
    scene.apply([{ kind: "removed", previous: shape("b", "a1", 200) }]);
    const loose = scene.get(arrow.id) as Shape;
    expect(loose.x + loose.w).toBeCloseTo(-998);
    expect(loose.y + loose.h).toBeCloseTo(-998);
    expect(loose.x).toBeLessThan(0); // on a's outline, toward that end
    scene.apply([{ kind: "added", shape: shape("b", "a1", 200) }]);
    expect(scene.get(arrow.id)).toMatchObject({ x: 18, w: 174 });

    // Detached, it's drawn where it's stored, and the shapes forget it.
    scene.apply([{ kind: "updated", shape: { ...arrow, from: null, to: null }, previous: arrow }]);
    expect(scene.get(arrow.id)).toMatchObject({ x: -999, y: -999, w: 1, h: 1 });
    expect(scene.arrowsAttachedTo("a" as ShapeId)).toEqual([]);
  });
});
