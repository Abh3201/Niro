import type { Shape, ShapeId } from "@niro/doc";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LIGHT_PALETTE } from "./render";
import { shapeOutline } from "./shapes";
import {
  fittedTextHeight,
  inkColor,
  layoutText,
  TEXT_FONT_SIZE,
  TextLayouts,
  textHeight,
  withHeight,
  wrapText,
} from "./text";

/** Every UTF-16 code unit one unit wide at font size 1: easy to count. */
const measure = (s: string) => s.length;

const shape = (patch: Partial<Shape>): Shape => ({
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

describe("wrapText", () => {
  // At font size 10, every character is 10 wide.
  const wrap = (text: string, maxWidth: number) => wrapText(text, maxWidth, 10, measure);

  it("breaks at spaces, and keeps newlines and empty lines", () => {
    expect(wrap("hello world", 60)).toEqual(["hello", "world"]);
    expect(wrap("hello world", 110)).toEqual(["hello world"]);
    expect(wrap("a\n\nb", 100)).toEqual(["a", "", "b"]);
    expect(wrap("", 100)).toEqual([""]);
  });

  it("keeps spaces, letting them hang off the end of a line as a browser does", () => {
    expect(wrap("  x", 100)).toEqual(["  x"]);
    expect(wrap("ab   cd", 40)).toEqual(["ab  ", "cd"]);
  });

  it("breaks a word too long for a line between characters", () => {
    expect(wrap("abcdefghij", 35)).toEqual(["abc", "def", "ghi", "j"]);
    expect(wrap("ab abcdefghij", 35)).toEqual(["ab", "abc", "def", "ghi", "j"]);
  });

  it("never splits an emoji, and survives a character wider than the line", () => {
    // Each emoji is two code units, so 20 wide; three code units would fit 35.
    expect(wrap("😀😀😀", 35)).toEqual(["😀", "😀", "😀"]);
    expect(wrap("W", 5)).toEqual(["W"]);
    expect(wrap("😀", 5)).toEqual(["😀"]);
  });

  it("loses no characters but the spaces it breaks at", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "😀") }),
        fc.integer({ min: 1, max: 200 }),
        (text, maxWidth) => {
          const lines = wrap(text, maxWidth);
          const strip = (s: string) => s.replace(/[ \n]/g, "");
          expect(strip(lines.join(""))).toBe(strip(text));
          for (const line of lines) {
            // Too wide only when one character is wider than the line on its own.
            if (line.trimEnd().length * 10 > maxWidth) expect([...line.trimEnd()]).toHaveLength(1);
          }
        },
      ),
    );
  });
});

describe("layoutText", () => {
  it("wraps a text shape at its width, left-aligned from its top-left", () => {
    const text = shape({ type: "text", w: 240, h: 30, text: "x".repeat(15) });
    const layout = layoutText(text, measure);
    expect(layout).toMatchObject({ fontSize: TEXT_FONT_SIZE, align: "left", x: -120, y: -15 });
    // 24 wide characters, 10 to a 240-wide line.
    expect(layout.lines).toEqual(["x".repeat(10), "x".repeat(5)]);
    expect(layout.widths).toEqual([240, 120]);
  });

  it("centers short text on a sticky note at its largest size", () => {
    const layout = layoutText(shape({ text: "hi" }), measure);
    expect(layout.align).toBe("center");
    expect(layout.fontSize).toBe(24); // 12% of 200
    expect(layout.y).toBe(-textHeight(1, 24) / 2);
  });

  it("shrinks longer text until it fits inside the shape", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom("a", " ", "\n"), maxLength: 400 }),
        fc.constantFrom<Shape["type"]>("sticky", "rectangle", "ellipse"),
        fc.integer({ min: 20, max: 600 }),
        fc.integer({ min: 20, max: 600 }),
        (text, type, w, h) => {
          const layout = layoutText(shape({ type, w, h, text }), measure);
          const height = textHeight(layout.lines.length, layout.fontSize);
          expect(-layout.y * 2).toBeCloseTo(height);
          // It fits, unless even the smallest size doesn't.
          if (layout.fontSize > 1.01) expect(height).toBeLessThanOrEqual(h);
          for (const width of layout.widths) {
            if (width > layout.width) expect(width).toBe(layout.fontSize); // one character
          }
        },
      ),
    );
  });

  it("keeps an ellipse's text inside its curve", () => {
    const rectangle = layoutText(shape({ type: "rectangle", text: "hi" }), measure);
    const ellipse = layoutText(shape({ type: "ellipse", text: "hi" }), measure);
    expect(ellipse.width).toBeLessThan(rectangle.width);
  });
});

describe("fittedTextHeight", () => {
  it("is one line at least, and grows a line at a time", () => {
    const text = (t: string) => shape({ type: "text", w: 240, h: 30, text: t });
    expect(fittedTextHeight(text(""), measure)).toBe(30);
    expect(fittedTextHeight(text("x".repeat(10)), measure)).toBe(30);
    expect(fittedTextHeight(text("x".repeat(11)), measure)).toBe(60);
    expect(fittedTextHeight(text("a\nb\nc"), measure)).toBe(90);
  });
});

describe("withHeight", () => {
  it("keeps the top edge where it is, however the shape is turned", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: 1, max: 500, noNaN: true }),
        (rotation, h) => {
          const before = shape({ type: "text", x: 10, y: 20, w: 240, h: 30, rotation });
          const patch = withHeight(before, h);
          const after = { ...before, ...patch };
          const [a, b] = shapeOutline(before);
          const [c, d] = shapeOutline(after);
          expect(c?.x).toBeCloseTo(a?.x ?? Number.NaN);
          expect(c?.y).toBeCloseTo(a?.y ?? Number.NaN);
          expect(d?.x).toBeCloseTo(b?.x ?? Number.NaN);
          expect(d?.y).toBeCloseTo(b?.y ?? Number.NaN);
          expect(after.h).toBe(h);
        },
      ),
    );
  });

  it("changes nothing when the height is right", () => {
    expect(withHeight(shape({ h: 30 }), 30)).toBeNull();
  });
});

describe("inkColor", () => {
  it("writes dark on stickies and light fills, light on dark fills, and in the text's own color", () => {
    expect(inkColor(shape({ type: "sticky" }), LIGHT_PALETTE)).toBe("#1e1e24");
    expect(inkColor(shape({ type: "rectangle", color: "yellow" }), LIGHT_PALETTE)).toBe("#1e1e24");
    expect(inkColor(shape({ type: "rectangle", color: "black" }), LIGHT_PALETTE)).toBe("#ffffff");
    expect(inkColor(shape({ type: "text", color: "red" }), LIGHT_PALETTE)).toBe(
      LIGHT_PALETTE.solid.red,
    );
  });
});

describe("TextLayouts", () => {
  it("lays out a shape once, until its size or text changes", () => {
    const layouts = new TextLayouts(measure);
    const a = shape({ text: "hi" });
    expect(layouts.get({ ...a, x: 500 })).toBe(layouts.get(a));
    expect(layouts.get({ ...a, text: "hello" })).not.toBe(layouts.get(a));
    expect(layouts.get({ ...a, w: 300 })).not.toBe(layouts.get(a));
  });
});
