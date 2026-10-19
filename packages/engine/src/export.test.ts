import type { Shape, ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { type ExportInput, exportSvg, pngScale } from "./export";
import { strokeShape } from "./freehand";
import { LIGHT_PALETTE } from "./render";
import { Scene } from "./scene";
import { memoryDoc } from "./test-doc";
import { TextLayouts } from "./text";

const shape = (id: string, patch: Partial<Shape> = {}): Shape => ({
  id: id as ShapeId,
  type: "rectangle",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  parentId: null,
  index: "a0",
  color: "blue",
  text: "",
  points: [],
  from: null,
  to: null,
  ...patch,
});

function input(shapes: Shape[], ids: string[] | null = null): ExportInput {
  const scene = new Scene(memoryDoc(shapes));
  const layouts = new TextLayouts((s) => s.length * 0.5);
  return {
    scene,
    ids: ids as ShapeId[] | null,
    palette: LIGHT_PALETTE,
    background: "#ffffff",
    baseline: 0.8,
    textLayout: (s) => (s.text === "" ? undefined : layouts.get(s)),
    stroke: () => undefined,
  };
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("exportSvg", () => {
  const board = [
    shape("frame", { type: "frame", x: 0, y: 0, w: 400, h: 300, color: "grey", text: "Plan" }),
    shape("note", {
      type: "sticky",
      parentId: "frame" as ShapeId,
      x: 20,
      y: 20,
      w: 200,
      h: 200,
      color: "yellow",
      text: 'Ship <it> & "go"',
    }),
    shape("box", { x: 600, y: 0, rotation: 0.5, index: "a1" }),
    shape("oval", { type: "ellipse", x: 800, y: 0, index: "a2" }),
    shape("arrow", { type: "arrow", x: 0, y: 500, w: 300, h: 0, color: "black", index: "a3" }),
    shape("pen", {
      type: "freehand",
      color: "black",
      index: "a4",
      ...strokeShape([
        { x: 0, y: 700, pressure: 0.5 },
        { x: 50, y: 720, pressure: 0.5 },
        { x: 100, y: 700, pressure: 0.5 },
      ]),
    }),
    shape("label", { type: "text", x: 600, y: 400, w: 300, h: 30, text: "Notes", index: "a5" }),
  ];

  it("draws every kind of shape, clipped by its frame, with text escaped", () => {
    const svg = exportSvg(input(board)) as string;
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    // The frame's name, the note's text and the text shape.
    expect(svg).toContain(">Plan</text>");
    expect(svg).toContain("&lt;it&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;go&quot;");
    expect(svg).not.toContain("<it>");
    expect(svg).toContain(">Notes</text>");
    // The note is in the frame, so it's clipped to it.
    expect(count(svg, "<clipPath")).toBe(1);
    expect(count(svg, "<g ")).toBe(count(svg, "</g>"));
    // The turned box, the ellipse's arcs, the arrow's shaft and the pen stroke.
    expect(svg).toContain("transform=");
    expect(svg).toMatch(/d="M[^"]*A/);
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toMatch(/d="M[^"]*Q/);
  });

  it("drops characters XML forbids, so the file always opens", () => {
    const text = "a\u0001b\uD800c\uDC00d\uFFFEe 😀";
    const svg = exportSvg(input([shape("label", { type: "text", w: 300, h: 30, text })])) as string;
    expect(svg).toContain(">abcde 😀</text>");
  });

  it("frames the shapes with a margin", () => {
    const svg = exportSvg(input([shape("a", { x: 10, y: 20, w: 100, h: 50 })])) as string;
    // A rectangle has a 1-unit edge allowance, then 32 units of margin.
    expect(svg).toContain('viewBox="-23 -13 166 116"');
    expect(svg).toContain('width="166" height="116"');
  });

  it("exports only what's selected, with what's in it", () => {
    const svg = exportSvg(input(board, ["frame"])) as string;
    expect(svg).toContain(">Plan</text>");
    expect(svg).toContain("Ship");
    expect(svg).not.toContain(">Notes</text>");
  });

  it("has nothing to export on an empty board", () => {
    expect(exportSvg(input([]))).toBeNull();
  });
});

describe("pngScale", () => {
  it("is 2 for ordinary boards, and shrinks to stay inside what canvases allow", () => {
    expect(pngScale(1_000, 800)).toBe(2);
    expect(pngScale(10_000, 100)).toBeCloseTo(0.8192);
    const big = pngScale(20_000, 20_000);
    expect(20_000 * big).toBeLessThanOrEqual(8_192);
    expect((20_000 * big) ** 2).toBeLessThanOrEqual(64_000_000 + 1);
  });
});
