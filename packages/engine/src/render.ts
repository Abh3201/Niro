import type { ColorName, Shape } from "@niro/doc";
import { shapeCenter } from "./shapes";
import { FONT_FAMILY, inkColor, LINE_HEIGHT, type TextLayout } from "./text";

export interface Palette {
  /** Shape fills and line strokes. */
  solid: Record<ColorName, string>;
  /** Sticky note paper. */
  paper: Record<ColorName, string>;
  /** Selection, handles and marquee. */
  accent: string;
  handleFill: string;
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
};

export const DARK_PALETTE: Palette = {
  // "Black" ink has to stay visible on a dark board.
  solid: { ...SOLID, black: "#e4e4e7" },
  paper: PAPER,
  accent: "#60a5fa",
  handleFill: "#1e1e24",
};

export const LINE_WIDTH = 4;
const STICKY_SHADOW = "rgba(0, 0, 0, 0.14)";
/** Text smaller than this on screen, in CSS pixels, is drawn as bars: unreadable anyway, and much cheaper. */
const GREEK_BELOW_PX = 4;

/** A shape's text, laid out, and how to draw it. */
export interface ShapeText {
  readonly layout: TextLayout;
  /** `FontMetrics.baseline`. */
  readonly baseline: number;
  /** Screen pixels per world unit. */
  readonly zoom: number;
}

/**
 * Draws one shape, and its text when `text` is given. Expects the context
 * to be transformed to world coordinates.
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  palette: Palette,
  text?: ShapeText,
): void {
  if (shape.type === "line") {
    ctx.strokeStyle = palette.solid[shape.color];
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(shape.x, shape.y);
    ctx.lineTo(shape.x + shape.w, shape.y + shape.h);
    ctx.stroke();
    return;
  }

  const { w, h, rotation } = shape;
  const c = shapeCenter(shape);
  ctx.save();
  ctx.translate(c.x, c.y);
  if (rotation !== 0) ctx.rotate(rotation);
  switch (shape.type) {
    case "rectangle":
      ctx.fillStyle = palette.solid[shape.color];
      ctx.fillRect(-w / 2, -h / 2, w, h);
      break;
    case "ellipse":
      ctx.fillStyle = palette.solid[shape.color];
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "sticky": {
      // An offset rectangle is a much cheaper shadow than `shadowBlur`.
      const offset = Math.min(w, h) * 0.02;
      ctx.fillStyle = STICKY_SHADOW;
      ctx.fillRect(-w / 2 + offset, -h / 2 + offset * 2, w, h);
      ctx.fillStyle = palette.paper[shape.color];
      ctx.fillRect(-w / 2, -h / 2, w, h);
      break;
    }
    case "text":
      // Just the text.
      break;
  }
  if (text) drawText(ctx, text, inkColor(shape, palette));
  ctx.restore();
}

/** Draws laid-out text, in the shape's own frame. */
function drawText(ctx: CanvasRenderingContext2D, text: ShapeText, ink: string): void {
  const { layout, baseline, zoom } = text;
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
