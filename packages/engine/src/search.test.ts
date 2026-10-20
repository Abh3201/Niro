import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { Scene } from "./scene";
import { MAX_SEARCH_RESULTS, searchShapes } from "./search";
import { memoryDoc } from "./test-doc";

const shape = (id: string, patch: Partial<Shape> = {}): Shape => ({
  id: id as ShapeId,
  type: "sticky",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  parentId: null,
  index: "a0",
  color: "yellow",
  text: "",
  points: [],
  from: null,
  to: null,
  ...patch,
});

describe("searchShapes", () => {
  const scene = new Scene(
    memoryDoc([
      shape("low", { y: 300, text: "Ship the Roadmap" }),
      shape("right", { x: 400, y: 0, text: "road  map\nnotes" }),
      shape("left", { x: 0, y: 0, text: "ROADMAP review" }),
      shape("frame", { type: "frame", x: 600, y: 600, text: "Roadmap Q4" }),
      shape("group", { type: "group", w: 0, h: 0 }),
      shape("inner", { parentId: "group" as ShapeId, x: 0, y: 900, text: "roadmap in a group" }),
      shape("none", { x: 50, y: 50, text: "unrelated" }),
      shape("pen", { type: "freehand", x: 10, y: 10 }),
    ]),
  );

  it("finds text without regard to case, in reading order, inside groups and frame names too", () => {
    expect(searchShapes(scene, "roadmap")).toEqual(["left", "low", "frame", "inner"]);
  });

  it("ignores runs of whitespace, and finds nothing for a blank query", () => {
    expect(searchShapes(scene, "road map")).toEqual(["right"]);
    expect(searchShapes(scene, "  ")).toEqual([]);
    expect(searchShapes(scene, "")).toEqual([]);
  });

  it("caps a very loose query", () => {
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 20 }, (_, i) =>
      shape(`s${i}`, { y: i, text: "x" }),
    );
    expect(searchShapes(new Scene(memoryDoc(many)), "x")).toHaveLength(MAX_SEARCH_RESULTS);
  });
});
