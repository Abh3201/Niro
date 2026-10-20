import { type ColorName, defaultHead, isLinear, type Shape } from "@niro/doc";
import { linePoints } from "./elbow";
import { PEN_SIZE } from "./freehand";
import { type Box, boxFromPoints, type Point, rotateAround, unionBoxes } from "./geometry";
import { reactionsExtent } from "./reactions";
import { shapeCenter, shapeExtent } from "./shapes";
import { FONT_FAMILY, inkColor, LINE_HEIGHT, MEASURE_SIZE, type TextLayout } from "./text";

export interface Palette {
  /** Shape fills and line strokes. */
  solid: Record<ColorName, string>;
  /** Sticky note paper. */
  paper: Record<ColorName, string>;
  /** Selection, handles and marquee. */
  accent: string;
  /** Snap guide lines. */
  guide: string;
  handleFill: string;
  /** Frames: the plain surface (grey frames), the edge, and the name. */
  frame: { fill: string; border: string; label: string };
}

const SOLID: Record<ColorName, string> = {
  black: "#1e1e24",
  grey: "#9ca3af",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#facc15",
  orange: "#f97316",
  red: "#ef4444",
  violet: "#8b5cf6",
};

const PAPER: Record<ColorName, string> = {
  black: "#d4d4d8",
  grey: "#f3f4f6",
  blue: "#bfdbfe",
  green: "#bbf7d0",
  yellow: "#fef08a",
  orange: "#fed7aa",
  red: "#fecaca",
  violet: "#ddd6fe",
};

export const LIGHT_PALETTE: Palette = {
  solid: SOLID,
  paper: PAPER,
  accent: "#2563eb",
  guide: "#db2777",
  handleFill: "#ffffff",
  frame: { fill: "#ffffff", border: "#d4d4d8", label: "#6b7280" },
};

export const DARK_PALETTE: Palette = {
  // "Black" ink has to stay visible on a dark board.
  solid: { ...SOLID, black: "#e4e4e7" },
  paper: PAPER,
  accent: "#60a5fa",
  guide: "#f472b6",
  handleFill: "#1e1e24",
  frame: { fill: "#232329", border: "#3f3f46", label: "#a1a1aa" },
};

import { HEAD_WIDTHS, lineWidthOf } from "./line-style";

const STICKY_SHADOW = "rgba(0, 0, 0, 0.14)";
/** Text smaller than this on screen, in CSS pixels, is drawn as bars: unreadable anyway, and much cheaper. */
const GREEK_BELOW_PX = 4;

/**
 * The box `drawShape` draws `shape` in, given its text's layout (if it's
 * drawn with text): anything outside it is off screen when the box is.
 */
export function drawnExtent(shape: Shape, layout?: TextLayout): Box {
  const box = shapeBoxExtent(shape, layout);
  // Reactions are drawn under the shape.
  const reactions = reactionsExtent(shape);
  return reactions ? (unionBoxes([box, reactions]) ?? box) : box;
}

function shapeBoxExtent(shape: Shape, layout?: TextLayout): Box {
  const box = shapeExtent(shape);
  const pad = isLinear(shape.type)
    ? // Round caps, and an arrowhead's wings.
      lineWidthOf(shape) * HEAD_WIDTHS
    : shape.type === "freehand"
      ? // The stroke is a fixed width however the box is scaled.
        PEN_SIZE
      : shape.type === "sticky"
        ? // The shadow.
          Math.min(shape.w, shape.h) * 0.04
        : // A frame's 1-unit edge, and anti-aliasing.
          1;
  const padded = {
    minX: box.minX - pad,
    minY: box.minY - pad,
    maxX: box.maxX + pad,
    maxY: box.maxY + pad,
  };
  if (!layout || layout.lines.length === 0) return padded;
  // Text is laid out in the shape's own frame, and turns with it.
  const c = shapeCenter(shape);
  const height = layout.lines.length * layout.fontSize * LINE_HEIGHT;
  const corners = [
    { x: layout.x, y: layout.y },
    { x: layout.x + layout.width, y: layout.y },
    { x: layout.x + layout.width, y: layout.y + height },
    { x: layout.x, y: layout.y + height },
  ].map((p) => rotateAround({ x: c.x + p.x, y: c.y + p.y }, c, shape.rotation));
  return unionBoxes([padded, boxFromPoints(corners)]) ?? padded;
}

/** A shape's text, laid out, and how to draw it. */
export interface ShapeText {
  readonly layout: TextLayout;
  /** `FontMetrics.baseline`. */
  readonly baseline: number;
  /** Screen pixels per world unit. */
  readonly zoom: number;
}

/** What a shape needs drawn besides its own geometry. */
export interface ShapeExtras {
  readonly text?: ShapeText;
  /** A freehand stroke's outline, in its own frame. */
  readonly stroke?: Path2D;
  /** An image's picture, once loaded; until then a placeholder is drawn. */
  readonly image?: CanvasImageSource;
}

/** Below this size on screen, in CSS pixels, a sticky note has no shadow: it would be a smudge. */
const SHADOW_ABOVE_PX = 16;
/** Text smaller than this on screen isn't drawn at all: even its bars would be under a pixel. */
const HIDE_TEXT_BELOW_PX = 2.5;

/**
 * Draws one shape, and its text when it has some. Expects the context to
 * be transformed to world coordinates; `zoom` is screen pixels per world
 * unit, for leaving out detail too small to see.
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  palette: Palette,
  zoom: number,
  extras: ShapeExtras = {},
): void {
  if (isLinear(shape.type)) {
    drawLine(ctx, shape, palette.solid[shape.color]);
    return;
  }

  const { w, h, rotation } = shape;
  const c = shapeCenter(shape);
  // Upright shapes, nearly all of them, are drawn where they are. Moving the
  // context to each shape's center (save, translate, restore) costs more
  // than drawing a rectangle, thousands of times a frame when zoomed out.
  const turned = rotation !== 0;
  if (turned) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(rotation);
  }
  // The center, in whatever the context is now.
  const cx = turned ? 0 : c.x;
  const cy = turned ? 0 : c.y;
  const left = cx - w / 2;
  const top = cy - h / 2;
  switch (shape.type) {
    case "rectangle":
      ctx.fillStyle = palette.solid[shape.color];
      ctx.fillRect(left, top, w, h);
      break;
    case "ellipse":
      ctx.fillStyle = palette.solid[shape.color];
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "sticky": {
      if (Math.min(w, h) * zoom >= SHADOW_ABOVE_PX) {
        // An offset rectangle is a much cheaper shadow than `shadowBlur`.
        const offset = Math.min(w, h) * 0.02;
        ctx.fillStyle = STICKY_SHADOW;
        ctx.fillRect(left + offset, top + offset * 2, w, h);
      }
      ctx.fillStyle = palette.paper[shape.color];
      ctx.fillRect(left, top, w, h);
      break;
    }
    case "freehand":
      if (extras.stroke) {
        // The outline is in the stroke's own frame.
        ctx.translate(cx, cy);
        ctx.fillStyle = palette.solid[shape.color];
        ctx.fill(extras.stroke);
        ctx.translate(-cx, -cy);
      }
      break;
    case "frame":
      // Grey, the default, is the plain surface.
      ctx.fillStyle = shape.color === "grey" ? palette.frame.fill : palette.paper[shape.color];
      ctx.fillRect(left, top, w, h);
      ctx.strokeStyle = palette.frame.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(left, top, w, h);
      break;
    case "image":
      if (extras.image) {
        ctx.drawImage(extras.image, left, top, w, h);
      } else {
        ctx.fillStyle = palette.paper.grey;
        ctx.fillRect(left, top, w, h);
        ctx.strokeStyle = palette.frame.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, w, h);
      }
      break;
    case "text":
    case "group":
      // Just the text; groups draw nothing of their own.
      break;
  }
  const { text } = extras;
  if (text && text.layout.fontSize * zoom >= HIDE_TEXT_BELOW_PX)
    drawText(ctx, text, inkColor(shape, palette), cx, cy);
  if (turned) ctx.restore();
}

/** A line, or an arrow: dashed or not, with a filled head at either end or both, along a straight or elbowed path. */
function drawLine(ctx: CanvasRenderingContext2D, shape: Shape, color: string): void {
  const points = linePoints(shape);
  const first = points[0] as Point;
  const second = points[1] as Point;
  const last = points[points.length - 1] as Point;
  const beforeLast = points[points.length - 2] as Point;
  const width = lineWidthOf(shape);
  const heads = shape.head ?? defaultHead(shape.type);
  const startLength = Math.hypot(second.x - first.x, second.y - first.y);
  const endLength = Math.hypot(beforeLast.x - last.x, beforeLast.y - last.y);
  // Unit vectors pointing from each end along the shaft.
  const sx = startLength > 0 ? (second.x - first.x) / startLength : 0;
  const sy = startLength > 0 ? (second.y - first.y) / startLength : 0;
  const ex = endLength > 0 ? (beforeLast.x - last.x) / endLength : 0;
  const ey = endLength > 0 ? (beforeLast.y - last.y) / endLength : 0;
  // A head is at most half the segment it sits on, so a short last segment gets a small one.
  const startHead =
    heads === "start" || heads === "both" ? Math.min(width * HEAD_WIDTHS, startLength * 0.5) : 0;
  const endHead =
    heads === "end" || heads === "both" ? Math.min(width * HEAD_WIDTHS, endLength * 0.5) : 0;
  // The shaft stops inside each head, so its round cap can't poke through the tip.
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const dash = shape.dash ?? "solid";
  // Dots are zero-length dashes, which round caps make into circles.
  if (dash === "dashed") ctx.setLineDash([width * 3, width * 2.5]);
  else if (dash === "dotted") ctx.setLineDash([0.01, width * 2.2]);
  ctx.beginPath();
  ctx.moveTo(first.x + sx * startHead * 0.6, first.y + sy * startHead * 0.6);
  for (let i = 1; i < points.length - 1; i++)
    ctx.lineTo((points[i] as Point).x, (points[i] as Point).y);
  ctx.lineTo(last.x + ex * endHead * 0.6, last.y + ey * endHead * 0.6);
  ctx.stroke();
  if (dash !== "solid") ctx.setLineDash([]);
  ctx.fillStyle = color;
  if (endHead > 0) drawHead(ctx, last, ex, ey, endHead);
  if (startHead > 0) drawHead(ctx, first, sx, sy, startHead);
}

/** A filled arrowhead with its tip at `tip`, `size` long toward `(dx, dy)`, the unit direction of the shaft. */
function drawHead(
  ctx: CanvasRenderingContext2D,
  tip: { x: number; y: number },
  dx: number,
  dy: number,
  size: number,
): void {
  const back = { x: tip.x + dx * size, y: tip.y + dy * size };
  const half = size * 0.45;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(back.x - dy * half, back.y + dx * half);
  ctx.lineTo(back.x + dy * half, back.y - dx * half);
  ctx.closePath();
  ctx.fill();
}

/** Draws laid-out text, centered on `(cx, cy)`: the shape's center. */
function drawText(
  ctx: CanvasRenderingContext2D,
  text: ShapeText,
  ink: string,
  cx: number,
  cy: number,
): void {
  const { baseline, zoom } = text;
  const layout = { ...text.layout, x: text.layout.x + cx, y: text.layout.y + cy };
  const { fontSize, lines, widths } = layout;
  const lineHeight = fontSize * LINE_HEIGHT;
  const left = (i: number) =>
    layout.align === "left" ? layout.x : layout.x + (layout.width - (widths[i] ?? 0)) / 2;
  ctx.fillStyle = ink;

  if (fontSize * zoom < GREEK_BELOW_PX) {
    ctx.globalAlpha = 0.35;
    lines.forEach((_, i) => {
      const width = widths[i] ?? 0;
      if (width > 0)
        ctx.fillRect(left(i), layout.y + i * lineHeight + fontSize * 0.25, width, fontSize * 0.6);
    });
    ctx.globalAlpha = 1;
    return;
  }

  // Set at the size it was measured at and scaled down, so each line is as
  // wide as `measure` said (see text.ts). `maxWidth` squeezes a line that
  // still comes out wider, rather than letting it run out of its shape.
  // Scaling back after is cheaper than save and restore, which add up when
  // thousands of notes are on screen.
  const k = fontSize / MEASURE_SIZE;
  ctx.scale(k, k);
  ctx.font = `${MEASURE_SIZE}px ${FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => {
    if (line.trim() !== "")
      ctx.fillText(
        line,
        left(i) / k,
        (layout.y + i * lineHeight + baseline * fontSize) / k,
        // A line can't be wider than the room right of where it starts, unless
        // it's one character that never fit.
        Math.max(widths[i] ?? 0, layout.x + layout.width - left(i)) / k,
      );
  });
  ctx.scale(1 / k, 1 / k);
}
