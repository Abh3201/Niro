import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { boxFromPoints } from "./geometry";
import { drawnExtent, drawShape, LIGHT_PALETTE } from "./render";
import { shapeOutline } from "./shapes";
import { layoutText } from "./text";

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
