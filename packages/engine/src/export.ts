import type { Shape, ShapeId } from "@niro/doc";
import { localPenPoints, strokeOutline, traceOutline } from "./freehand";
import { type Box, unionBoxes } from "./geometry";
import { paintShapes } from "./paint";
import { drawnExtent, type Palette } from "./render";
import type { Scene } from "./scene";
import { withDescendants } from "./structure";
import { SvgContext, SvgPath } from "./svg-context";
import type { TextLayout } from "./text";

/** Space around what's exported, in world units. */
const MARGIN = 32;
/** Device pixels per world unit in a PNG, for sharp text on high-density screens. */
const PNG_SCALE = 2;
/** Largest PNG side, and area, browsers reliably make a canvas for. */
const MAX_SIDE = 8_192;
const MAX_AREA = 64_000_000;
/** Detail to draw at: everything, as though zoomed far in. */
const FULL_DETAIL = 1_000;

export interface ExportInput {
  readonly scene: Scene;
  /** Shapes to export (with what's in them), or null for the whole board. */
  readonly ids: readonly ShapeId[] | null;
  readonly palette: Palette;
  /** Fill behind the shapes. */
  readonly background: string;
  textLayout(shape: Shape): TextLayout | undefined;
  stroke(shape: Shape): Path2D | undefined;
}

/** What gets drawn, in draw order, and the box around it, margin included. */
export function exportArea(input: ExportInput): { shapes: Shape[]; box: Box } | null {
  const { scene, ids } = input;
  const wanted = ids && new Set(withDescendants(scene, ids));
  const shapes = scene
    .ordered()
    // A group draws nothing, and an empty one has no place.
    .filter((s) => (!wanted || wanted.has(s.id)) && s.type !== "group");
  const box = unionBoxes(shapes.map((s) => drawnExtent(s, input.textLayout(s))));
  if (!box) return null;
  return {
    shapes,
    box: {
      minX: box.minX - MARGIN,
      minY: box.minY - MARGIN,
      maxX: box.maxX + MARGIN,
      maxY: box.maxY + MARGIN,
    },
  };
}

/** The shapes as an SVG document, one unit to a pixel; null when there's nothing to export. */
export function exportSvg(input: ExportInput): string | null {
  const area = exportArea(input);
  if (!area) return null;
  const { shapes, box } = area;
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const svg = new SvgContext();
  const ctx = svg as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = input.background;
  ctx.fillRect(box.minX, box.minY, w, h);
  paintShapes(ctx, shapes, {
    scene: input.scene,
    palette: input.palette,
    zoom: FULL_DETAIL,
    textLayout: input.textLayout,
    // The same outline the screen fills, as path data.
    stroke: (shape) => {
      const path = new SvgPath();
      traceOutline(path, strokeOutline(localPenPoints(shape)));
      return path as unknown as Path2D;
    },
  });
  return svg.toSvg({ x: box.minX, y: box.minY, w, h }, w, h);
}

/** The shapes as a PNG, at twice their size or as big as a canvas allows; null when there's nothing. */
export async function exportPng(input: ExportInput): Promise<Blob | null> {
  const area = exportArea(input);
  if (!area) return null;
  const { shapes, box } = area;
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const scale = pngScale(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
  ctx.setTransform(scale, 0, 0, scale, -box.minX * scale, -box.minY * scale);
  ctx.fillStyle = input.background;
  ctx.fillRect(box.minX, box.minY, w, h);
  paintShapes(ctx, shapes, {
    scene: input.scene,
    palette: input.palette,
    zoom: FULL_DETAIL,
    textLayout: input.textLayout,
    stroke: input.stroke,
  });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    ),
  );
}

/** Device pixels per world unit for a PNG of a `w` × `h` area. */
export function pngScale(w: number, h: number): number {
  return Math.min(PNG_SCALE, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)));
}
