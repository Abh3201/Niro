import { type ColorName, isLinear, type Shape } from "@niro/doc";
import { PEN_SIZE } from "./freehand";
import { type Box, boxFromPoints, rotateAround, unionBoxes } from "./geometry";
import { shapeCenter, shapeExtent } from "./shapes";
import { FONT_FAMILY, inkColor, LINE_HEIGHT, type TextLayout } from "./text";

export interface Palette {
  /** Shape fills and line strokes. */
  solid: Record<ColorName, string>;
  /** Sticky note paper. */
  paper: Record<ColorName, string>;
  /** Selection, handles and marquee. */
  accent: string;
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
  handleFill: "#ffffff",
  frame: { fill: "#ffffff", border: "#d4d4d8", label: "#6b7280" },
};

export const DARK_PALETTE: Palette = {
  // "Black" ink has to stay visible on a dark board.
  solid: { ...SOLID, black: "#e4e4e7" },
  paper: PAPER,
  accent: "#60a5fa",
  handleFill: "#1e1e24",
  frame: { fill: "#232329", border: "#3f3f46", label: "#a1a1aa" },
};

export const LINE_WIDTH = 4;
const STICKY_SHADOW = "rgba(0, 0, 0, 0.14)";
/** Text smaller than this on screen, in CSS pixels, is drawn as bars: unreadable anyway, and much cheaper. */
const GREEK_BELOW_PX = 4;

/**
 * The box `drawShape` draws `shape` in, given its text's layout (if it's
 * drawn with text): anything outside it is off screen when the box is.
 */
export function drawnExtent(shape: Shape, layout?: TextLayout): Box {
  const box = shapeExtent(shape);
  const pad = isLinear(shape.type)
    ? // Round caps, and an arrowhead's wings.
      ARROWHEAD
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

/** Length of an arrowhead, in world units; narrower arrows get smaller heads. */
const ARROWHEAD = LINE_WIDTH * 4;

/** A line, or an arrow with a filled head at its end. */
function drawLine(ctx: CanvasRenderingContext2D, shape: Shape, color: string): void {
  const { x, y, w, h } = shape;
  const length = Math.hypot(w, h);
  const head = shape.type === "arrow" ? Math.min(ARROWHEAD, length * 0.5) : 0;
  // The shaft stops inside the head, so its round cap can't poke through the tip.
  const shaft = length > 0 ? Math.max(0, length - head * 0.6) / length : 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w * shaft, y + h * shaft);
  ctx.stroke();
  if (head <= 0) return;
  const ux = w / length;
  const uy = h / length;
  const tip = { x: x + w, y: y + h };
  const back = { x: tip.x - ux * head, y: tip.y - uy * head };
  const half = head * 0.45;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(back.x - uy * half, back.y + ux * half);
  ctx.lineTo(back.x + uy * half, back.y - ux * half);
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

  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => {
    if (line.trim() !== "")
      ctx.fillText(line, left(i), layout.y + i * lineHeight + baseline * fontSize);
  });
}
