import { describe, expect, it } from "vitest";
import { MAX_COORDINATE, normalizeAngle, readShape } from "./shape";

const valid = {
  type: "rectangle",
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  rotation: 0.5,
  parentId: null,
  index: "a0",
  color: "red",
  text: "hi",
  points: [],
  from: null,
  to: null,
};

describe("readShape", () => {
  it("passes a valid shape through unchanged", () => {
    expect(readShape("s1", valid)).toEqual({ id: "s1", ...valid });
  });

  it("reads locks and line styles, leaving out defaults", () => {
    expect(readShape("s1", { ...valid, locked: true })).toMatchObject({ locked: true });
    expect(readShape("s1", { ...valid, locked: false })).not.toHaveProperty("locked");
    expect(readShape("s1", { ...valid, locked: "yes" })).not.toHaveProperty("locked");
    const line = { ...valid, type: "line" };
    expect(
      readShape("s1", { ...line, dash: "dashed", thickness: "thick", head: "both" }),
    ).toMatchObject({
      dash: "dashed",
      thickness: "thick",
      head: "both",
    });
    // Defaults are the same as nothing; so is anything unknown, and anything on a shape that isn't a line.
    const plain = readShape("s1", { ...line, dash: "solid", thickness: "medium", head: "none" });
    expect(plain).not.toHaveProperty("dash");
    expect(plain).not.toHaveProperty("thickness");
    expect(plain).not.toHaveProperty("head");
    expect(readShape("s1", { ...line, dash: "wavy", head: 3 })).not.toHaveProperty("dash");
    expect(readShape("s1", { ...valid, dash: "dashed" })).not.toHaveProperty("dash");
    // An arrow's default head is its end; none is what has to be stored.
    const arrow = { ...valid, type: "arrow" };
    expect(readShape("s1", { ...arrow, head: "end" })).not.toHaveProperty("head");
    expect(readShape("s1", { ...arrow, head: "none" })).toMatchObject({ head: "none" });
  });

  it("hides shapes of a type this version doesn't know", () => {
    expect(readShape("s1", { ...valid, type: "hologram" })).toBeNull();
    expect(readShape("s1", {})).toBeNull();
  });

  it("repairs bad values instead of passing them to the renderer", () => {
    const shape = readShape("s1", {
      type: "ellipse",
      x: Number.NaN,
      y: "12",
      w: -40,
      h: 0,
      rotation: Number.POSITIVE_INFINITY,
      parentId: "s1",
      index: "not a key",
      color: "#ff0000",
    });
    expect(shape).toEqual({
      id: "s1",
      type: "ellipse",
      x: 0,
      y: 0,
      w: 40,
      h: 1,
      rotation: 0,
      parentId: null,
      index: "a0",
      color: "green",
      text: "",
      points: [],
      from: null,
      to: null,
    });
  });

  it("reads text, and never gives a line any", () => {
    expect(readShape("s1", { ...valid, type: "text", text: "label" })?.text).toBe("label");
    expect(readShape("s1", { ...valid, text: 42 })?.text).toBe("");
    expect(readShape("l1", { ...valid, type: "line", text: "x" })?.text).toBe("");
  });

  it("keeps positions and sizes within reach of double precision", () => {
    expect(readShape("s1", { ...valid, x: 1e20, y: -1e300, w: 1e15 })).toMatchObject({
      x: MAX_COORDINATE,
      y: -MAX_COORDINATE,
      w: MAX_COORDINATE,
    });
    expect(readShape("l1", { ...valid, type: "line", h: -1e20 })?.h).toBe(-MAX_COORDINATE);
  });

  it("keeps negative width and height on lines, which point either way", () => {
    expect(readShape("l1", { ...valid, type: "line", w: -30, h: -40, rotation: 1 })).toMatchObject({
      w: -30,
      h: -40,
      rotation: 0,
    });
  });
});

describe("readShape: strokes and arrows", () => {
  it("reads a stroke's points as whole triples, clamped into range", () => {
    const stroke = { ...valid, type: "freehand" };
    expect(
      readShape("f1", { ...stroke, points: [0, 10_000, 50, 5_000, 5_000, 100] })?.points,
    ).toEqual([0, 10_000, 50, 5_000, 5_000, 100]);
    expect(readShape("f1", { ...stroke, points: [-5, 20_000, 150] })?.points).toEqual([
      0, 10_000, 100,
    ]);
    // Not triples, not numbers, or not a list: no points, rather than garbage.
    expect(readShape("f1", { ...stroke, points: [1, 2] })?.points).toEqual([]);
    expect(readShape("f1", { ...stroke, points: [1, "2", 3] })?.points).toEqual([]);
    expect(readShape("f1", { ...stroke, points: [1, Number.NaN, 3] })?.points).toEqual([]);
    expect(readShape("f1", { ...stroke, points: "1,2,3" })?.points).toEqual([]);
    // Only strokes have points.
    expect(readShape("s1", { ...valid, points: [1, 2, 3] })?.points).toEqual([]);
  });

  it("attaches only arrows, and never to themselves", () => {
    const arrow = { ...valid, type: "arrow", w: -30, h: 40 };
    expect(readShape("a1", { ...arrow, from: "s1", to: "s2" })).toMatchObject({
      from: "s1",
      to: "s2",
      w: -30,
      h: 40,
      rotation: 0,
      text: "",
    });
    expect(readShape("a1", { ...arrow, from: "a1", to: 7 })).toMatchObject({
      from: null,
      to: null,
    });
    expect(readShape("l1", { ...valid, type: "line", from: "s1", to: "s2" })).toMatchObject({
      from: null,
      to: null,
    });
  });
});

describe("readShape: groups and frames", () => {
  it("keeps them upright, and gives a frame its name but a group no text", () => {
    expect(readShape("f1", { ...valid, type: "frame", rotation: 1, text: "Plan" })).toMatchObject({
      rotation: 0,
      text: "Plan",
    });
    expect(readShape("g1", { ...valid, type: "group", rotation: 1, text: "x" })).toMatchObject({
      rotation: 0,
      text: "",
    });
  });
});

describe("normalizeAngle", () => {
  it("wraps into [0, 2π)", () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(normalizeAngle(5 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(0)).toBe(0);
  });
});
