import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { boxFromPoints } from "./geometry";
import { drawnExtent, drawShape, LIGHT_PALETTE } from "./render";
import { shapeOutline } from "./shapes";
import { layoutText, MEASURE_SIZE } from "./text";

const measure = (s: string) => s.length * 0.5;

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

/** A 2D context that records the names of the methods called on it. */
function recorder() {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_, name) =>
        typeof name === "string" ? (..._args: unknown[]) => calls.push(name) : undefined,
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  return { ctx, calls };
}

function draw(s: Shape, zoom: number) {
  const { ctx, calls } = recorder();
  const layout = s.text ? layoutText(s, measure) : undefined;
  drawShape(ctx, s, LIGHT_PALETTE, zoom, layout ? { text: { layout, baseline: 0.8, zoom } } : {});
  return calls;
}

const count = (calls: string[], name: string) => calls.filter((c) => c === name).length;

describe("drawShape", () => {
  const note = shape({ text: "one two three" });

  it("draws an upright shape where it is, without moving the context", () => {
    const calls = draw(note, 1);
    expect(calls).not.toContain("save");
    expect(calls).not.toContain("translate");
    // The shadow, the paper, then the text.
    expect(count(calls, "fillRect")).toBe(2);
    expect(calls).toContain("fillText");
  });

  it("turns the context for a turned shape, and puts it back", () => {
    const calls = draw({ ...note, rotation: 0.3 }, 1);
    expect(calls.slice(0, 3)).toEqual(["save", "translate", "rotate"]);
    expect(calls.at(-1)).toBe("restore");
  });

  it("leaves out what's too small to see when zoomed out", () => {
    // 200 units at 5% is 10 pixels: no shadow, and text far under a pixel.
    const calls = draw(note, 0.05);
    expect(count(calls, "fillRect")).toBe(1);
    expect(calls).not.toContain("fillText");
    // In between, text is drawn as bars.
    const greeked = draw(note, 0.15);
    expect(greeked).not.toContain("fillText");
    expect(count(greeked, "fillRect")).toBeGreaterThan(1);
  });
});

describe("drawing text", () => {
  /** Draws `s` and returns each line as drawn: where it starts, how wide it can be, and at what size, in world units. */
  function drawnLines(s: Shape) {
    const lines: { left: number; maxWidth: number; size: number; fontPx: number }[] = [];
    let scale = 1;
    let fontPx = 0;
    const ctx = new Proxy(
      {},
      {
        get: (_, name) => {
          if (name === "scale") return (k: number) => (scale *= k);
          if (name === "fillText")
            return (_t: string, x: number, _y: number, maxWidth: number) =>
              lines.push({
                left: x * scale,
                maxWidth: maxWidth * scale,
                size: fontPx * scale,
                fontPx,
              });
          return () => {};
        },
        set: (_, name, value) => {
          if (name === "font") fontPx = Number.parseFloat(value);
          return true;
        },
      },
    ) as CanvasRenderingContext2D;
    const layout = layoutText(s, measure);
    drawShape(ctx, s, LIGHT_PALETTE, 1, { text: { layout, baseline: 0.8, zoom: 1 } });
    return { lines, layout, scale };
  }

  it("sets text at the size it was measured at, scaled down, and puts the scale back", () => {
    const note = shape({ type: "rectangle", x: 0, y: 0, text: "some words to wrap in a box" });
    const { lines, layout, scale } = drawnLines(note);
    expect(lines.length).toBe(layout.lines.length);
    for (const line of lines) {
      expect(line.fontPx).toBe(MEASURE_SIZE);
      expect(line.size).toBeCloseTo(layout.fontSize);
    }
    expect(scale).toBeCloseTo(1);
  });

  it("never lets a line run past the shape's text box, even if the font draws it wider", () => {
    const box = shape({
      type: "rectangle",
      w: 300,
      h: 400,
      text: "uy uy yu fuy uy yu uf uf u fu ".repeat(6),
    });
    const { lines, layout } = drawnLines(box);
    const right = box.x + box.w / 2 + layout.x + layout.width;
    for (const line of lines) expect(line.left + line.maxWidth).toBeLessThanOrEqual(right + 1e-9);
  });

  it("lets a single character wider than the shape keep its width", () => {
    const narrow = shape({ type: "text", w: 1, text: "W" });
    const { lines } = drawnLines(narrow);
    expect(lines[0]?.maxWidth).toBeGreaterThan(1);
  });
});

describe("drawnExtent", () => {
  it("holds a turned shape's corners", () => {
    const turned = shape({ rotation: 0.7 });
    const outline = boxFromPoints(shapeOutline(turned));
    const extent = drawnExtent(turned);
    expect(extent.minX).toBeLessThanOrEqual(outline.minX);
    expect(extent.maxY).toBeGreaterThanOrEqual(outline.maxY);
  });

  it("holds a frame's name, however many lines it wraps to", () => {
    const frame = shape({ type: "frame", w: 20, h: 100, text: "a long name that wraps a lot" });
    const layout = layoutText(frame, measure);
    expect(layout.lines.length).toBeGreaterThan(2);
    // The layout is placed from the frame's center.
    expect(drawnExtent(frame, layout).minY).toBeLessThanOrEqual(frame.h / 2 + layout.y);
  });

  it("holds an arrow's head", () => {
    const arrow = shape({ type: "arrow", w: 100, h: 0 });
    const extent = drawnExtent(arrow);
    expect(extent.minY).toBeLessThan(-5);
    expect(extent.maxX).toBeGreaterThan(100);
  });
});

describe("lines", () => {
  const arrow = (patch: Partial<Shape> = {}) =>
    shape({ type: "arrow", color: "black", x: 0, y: 0, w: 200, h: 0, ...patch });

  it("draws one head by default, two for both ends, none for a line", () => {
    expect(count(draw(arrow(), 1), "fill")).toBe(1);
    expect(count(draw(arrow({ head: "both" }), 1), "fill")).toBe(2);
    expect(count(draw(arrow({ head: "none" }), 1), "fill")).toBe(0);
    expect(count(draw(arrow({ type: "line" }), 1), "fill")).toBe(0);
    expect(count(draw(arrow({ type: "line", head: "start" }), 1), "fill")).toBe(1);
  });

  it("dashes only dashed and dotted lines", () => {
    expect(count(draw(arrow(), 1), "setLineDash")).toBe(0);
    // Set for the stroke, and cleared after.
    expect(count(draw(arrow({ dash: "dashed" }), 1), "setLineDash")).toBe(2);
    expect(count(draw(arrow({ dash: "dotted" }), 1), "setLineDash")).toBe(2);
  });

  it("covers a thick line's cap and head in its extent", () => {
    const thin = drawnExtent(arrow({ thickness: "thin" }));
    const thick = drawnExtent(arrow({ thickness: "thick" }));
    expect(thin.minY).toBeGreaterThan(thick.minY);
    // An arrowhead is four widths long: the extent reaches at least that far past the line.
    expect(thick.minY).toBeLessThanOrEqual(-8 * 4);
  });
});
