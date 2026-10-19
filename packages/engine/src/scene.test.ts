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
});
