import { describe, expect, it } from "vitest";
import { normalizeAngle, readShape } from "./shape";

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
};

describe("readShape", () => {
  it("passes a valid shape through unchanged", () => {
    expect(readShape("s1", valid)).toEqual({ id: "s1", ...valid });
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
    });
  });

  it("reads text, and never gives a line any", () => {
    expect(readShape("s1", { ...valid, type: "text", text: "label" })?.text).toBe("label");
    expect(readShape("s1", { ...valid, text: 42 })?.text).toBe("");
    expect(readShape("l1", { ...valid, type: "line", text: "x" })?.text).toBe("");
  });

  it("keeps negative width and height on lines, which point either way", () => {
    expect(readShape("l1", { ...valid, type: "line", w: -30, h: -40, rotation: 1 })).toMatchObject({
      w: -30,
      h: -40,
      rotation: 0,
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
