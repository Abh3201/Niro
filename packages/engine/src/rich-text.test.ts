import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import {
  clearedBy,
  inlinePatch,
  mergeTextStyles,
  paragraphsIn,
  rangeTextStyle,
  shapeTextStyle,
} from "./rich-text";

const note = (patch: Partial<Shape>): Shape => ({
  id: "s1" as ShapeId,
  type: "sticky",
  x: 0,
  y: 0,
  w: 200,
  h: 200,
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

describe("rangeTextStyle", () => {
  const shape = note({
    text: "Title\nbody",
    font: "hand",
    textRuns: [
      { length: 5, marks: { underline: true, size: 32 } },
      { length: 1, marks: { underline: true, align: "right" } },
      { length: 4, marks: {} },
    ],
  });

  it("says what a range shares, and null where it differs", () => {
    expect(rangeTextStyle(shape, 0, 5)).toMatchObject({
      underline: true,
      fontSize: 32,
      font: "hand",
      align: "right",
    });
    // Title and its line break: the line break isn't drawn, so doesn't count.
    expect(rangeTextStyle(shape, 0, 6)).toMatchObject({ underline: true, fontSize: 32 });
    expect(rangeTextStyle(shape, 0, 10)).toMatchObject({
      underline: null,
      fontSize: null,
      font: "hand",
      align: null,
    });
    expect(shapeTextStyle(shape).underline).toBeNull();
  });

  it("at the caret, says what typing there would look like, held marks included", () => {
    expect(rangeTextStyle(shape, 5, 5)).toMatchObject({ underline: true, fontSize: 32 });
    expect(rangeTextStyle(shape, 7, 7)).toMatchObject({ underline: false, fontSize: "auto" });
    expect(rangeTextStyle(shape, 7, 7, { bold: true, size: null })).toMatchObject({ bold: true });
    expect(rangeTextStyle(shape, 3, 3, { size: null }).fontSize).toBe("auto");
  });

  it("merges shapes' styles, and knows when vertical alignment applies", () => {
    const text = note({ type: "text", text: "x", color: "red" });
    const merged = mergeTextStyles([shapeTextStyle(note({ text: "x" })), shapeTextStyle(text)]);
    expect(merged).toMatchObject({ font: "sans", textColor: null, valign: "middle", boxes: true });
    expect(mergeTextStyles([shapeTextStyle(text)])).toMatchObject({
      textColor: "red",
      valign: null,
    });
  });
});

describe("paragraphsIn", () => {
  it("finds the paragraphs a range touches", () => {
    expect(paragraphsIn("ab\ncd\nef", 1, 1)).toEqual([{ start: 0, end: 2 }]);
    expect(paragraphsIn("ab\ncd\nef", 1, 4)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
    expect(paragraphsIn("ab\n", 3, 3)).toEqual([{ start: 3, end: 3 }]);
  });
});

describe("inlinePatch and clearedBy", () => {
  it("turn panel settings into marks, and marks to take away", () => {
    expect(inlinePatch({ fontSize: "auto", textColor: "red", bold: true, align: "left" })).toEqual({
      size: null,
      color: "red",
      bold: true,
    });
    expect(clearedBy({ fontSize: 20, align: "left", valign: "top" })).toEqual({
      size: null,
      align: null,
    });
  });
});
