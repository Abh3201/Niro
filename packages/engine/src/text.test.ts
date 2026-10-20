import type { Shape, ShapeId } from "@niro/doc";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LIGHT_PALETTE } from "./render";
import { shapeOutline } from "./shapes";
import {
  cssFont,
  DEFAULT_FONT,
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

  it("keeps a whole board's layouts, so a redraw measures nothing", () => {
    let measured = 0;
    const layouts = new TextLayouts((s) => {
      measured++;
      return s.length;
    });
    const board = Array.from({ length: 12_000 }, (_, i) =>
      shape({ id: `s${i}` as ShapeId, text: `note ${i}` }),
    );
    for (const s of board) layouts.get(s);
    const first = measured;
    for (const s of board) layouts.get(s);
    expect(measured).toBe(first);
  });
});

describe("formatted text", () => {
  /** Plain text one unit per character; any other font twice as wide. */
  const styled = (s: string, font?: string) =>
    !font || font === DEFAULT_FONT ? s.length : s.length * 2;

  it("measures in the shape's font, bold and italic included", () => {
    expect(cssFont(shape({}))).toBe(DEFAULT_FONT);
    expect(cssFont(shape({ bold: true, italic: true, font: "serif" }))).toMatch(
      /^italic bold 100px Georgia/,
    );
    // Frames' names are never formatted.
    expect(cssFont(shape({ type: "frame", bold: true }))).toBe(DEFAULT_FONT);
    const plain = shape({ type: "text", w: 100, h: 30, text: "aaaa aaaa" });
    // At 24, "aaaa" is 96 plain and 192 bold: plain fits one word a line, bold breaks the words.
    expect(layoutText(plain, styled).lines).toEqual(["aaaa", "aaaa"]);
    const bold = layoutText({ ...plain, bold: true }, styled);
    expect(bold.font).toBe(cssFont({ ...plain, bold: true }));
    expect(bold.lines.length).toBeGreaterThan(2);
  });

  it("sets a text shape at its size, and fits its height to it", () => {
    const big = shape({ type: "text", w: 1000, h: 30, text: "hi", fontSize: 48 });
    expect(layoutText(big, measure).fontSize).toBe(48);
    expect(fittedTextHeight(big, measure)).toBe(textHeight(1, 48));
    expect(fittedTextHeight({ ...big, fontSize: "auto" }, measure)).toBe(
      textHeight(1, TEXT_FONT_SIZE),
    );
  });

  it("uses a box's size as its largest, still shrinking text that doesn't fit", () => {
    expect(layoutText(shape({ text: "hi", fontSize: 20 }), measure).fontSize).toBe(20);
    const long = layoutText(shape({ text: "word ".repeat(80), fontSize: 64 }), measure);
    expect(long.fontSize).toBeLessThan(64);
  });

  it("aligns across and down", () => {
    const top = layoutText(shape({ text: "hi", valign: "top", align: "right" }), measure);
    const middle = layoutText(shape({ text: "hi" }), measure);
    const bottom = layoutText(shape({ text: "hi", valign: "bottom" }), measure);
    expect(top.align).toBe("right");
    expect(middle.align).toBe("center");
    // A 200 square note has 16 of padding each side.
    expect(top.y).toBeCloseTo(-84);
    expect(middle.y).toBeCloseTo(-textHeight(1, middle.fontSize) / 2);
    expect(bottom.y + textHeight(1, bottom.fontSize)).toBeCloseTo(84);
  });

  it("lays a shape out again when its formatting changes", () => {
    let calls = 0;
    const layouts = new TextLayouts((s, font) => {
      calls++;
      return styled(s, font);
    });
    const note = shape({ text: "hello" });
    layouts.get(note);
    const before = calls;
    layouts.get(note);
    expect(calls).toBe(before);
    for (const patch of [
      { bold: true },
      { fontSize: 20 },
      { align: "left" as const },
      { valign: "top" as const },
    ]) {
      layouts.get({ ...note, ...patch });
      expect(calls).toBeGreaterThan(before);
    }
  });

  it("draws a set text color, on a note's paper as on a light board", () => {
    expect(inkColor(shape({ textColor: "red" }), LIGHT_PALETTE)).toBe(LIGHT_PALETTE.solid.red);
    const dark = { ...LIGHT_PALETTE, solid: { ...LIGHT_PALETTE.solid, black: "#eeeeee" } };
    expect(inkColor(shape({ textColor: "black" }), dark)).toBe(LIGHT_PALETTE.ink.black);
    expect(inkColor(shape({ type: "rectangle", textColor: "black" }), dark)).toBe("#eeeeee");
  });
});

describe("text formatted in parts", () => {
  const baseline = () => 1; // the baseline a whole font size down: easy to add up

  it("sets each part in its own size, lines as tall as their biggest part", () => {
    const text = shape({
      type: "text",
      w: 1000,
      h: 30,
      text: "Big\nsmall",
      textRuns: [
        { length: 4, marks: { size: 48, bold: true } },
        { length: 5, marks: {} },
      ],
    });
    const layout = layoutText(text, measure, baseline);
    expect(layout.rows.map((row) => row.text)).toEqual(["Big", "small"]);
    const [big, small] = layout.rows;
    expect(big?.height).toBe(48 * 1.25);
    expect(big?.baseline).toBe(48);
    expect(small?.top).toBe(48 * 1.25);
    expect(small?.height).toBe(TEXT_FONT_SIZE * 1.25);
    expect(layout.height).toBe(48 * 1.25 + TEXT_FONT_SIZE * 1.25);
    expect(big?.pieces[0]?.style).toMatchObject({ size: 48, bold: true });
    expect(big?.width).toBe(3 * 48);
    expect(fittedTextHeight(text, measure, baseline)).toBe(layout.height);
  });

  it("splits a line where its formatting changes, and wraps by the parts' own widths", () => {
    const text = shape({
      type: "text",
      w: 100,
      h: 30,
      text: "aa bb",
      textRuns: [
        { length: 3, marks: { size: 10 } },
        { length: 2, marks: { size: 40, color: "red" } },
      ],
    });
    // "aa " is 30 wide; "bb" 80: together past 100, so "bb" wraps.
    const layout = layoutText(text, measure, baseline);
    expect(layout.rows.map((row) => row.text)).toEqual(["aa", "bb"]);
    expect(layout.rows[0]?.width).toBe(20);
    expect(layout.rows[1]?.pieces[0]?.style.color).toBe("red");
    const wide = layoutText({ ...text, w: 120 }, measure, baseline);
    expect(wide.rows).toHaveLength(1);
    expect(wide.rows[0]?.pieces.map((p) => [p.text, p.x, p.width])).toEqual([
      ["aa ", 0, 30],
      ["bb", 30, 80],
    ]);
  });

  it("aligns each paragraph as its line break says, the last as the shape", () => {
    const note = shape({
      text: "a\nb\nc",
      align: "left",
      textRuns: [
        { length: 1, marks: {} },
        { length: 1, marks: { align: "right" } },
        { length: 3, marks: {} },
      ],
    });
    expect(layoutText(note, measure).rows.map((row) => row.align)).toEqual([
      "right",
      "left",
      "left",
    ]);
  });

  it("shrinks every size in a box by the same factor until the text fits", () => {
    const note = shape({
      w: 100,
      h: 100,
      text: "aaaa\nbb",
      textRuns: [
        { length: 5, marks: { size: 100 } },
        { length: 2, marks: {} },
      ],
    });
    const layout = layoutText(note, measure, baseline);
    expect(layout.scale).toBeLessThan(1);
    const first = layout.rows[0];
    const last = layout.rows[layout.rows.length - 1];
    expect(last?.text).toBe("bb");
    expect((first?.pieces[0]?.style.size ?? 0) / (last?.pieces[0]?.style.size ?? 1)).toBeCloseTo(
      100 / 12,
    );
    expect(layout.height).toBeLessThanOrEqual(100 - 2 * 8);
    // Each line fits across the box.
    for (const row of layout.rows) expect(row.width).toBeLessThanOrEqual(layout.width);
  });

  it("gives an empty line the size of what would be typed on it", () => {
    const text = shape({
      type: "text",
      text: "a\n",
      textRuns: [{ length: 2, marks: { size: 40 } }],
    });
    const layout = layoutText(text, measure, baseline);
    expect(layout.rows.map((row) => row.height)).toEqual([50, 50]);
  });

  it("lays a shape out again when parts of its text are formatted", () => {
    let calls = 0;
    const layouts = new TextLayouts((s) => {
      calls++;
      return s.length;
    });
    const note = shape({ text: "hello" });
    layouts.get(note);
    const before = calls;
    layouts.get({ ...note, textRuns: [{ length: 5, marks: { bold: true } }] });
    expect(calls).toBeGreaterThan(before);
  });
});
