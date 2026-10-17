import type { ColorName, Shape } from "@niro/doc";
import { shapeCenter } from "./shapes";

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

/** Draws one shape. Expects the context to be transformed to world coordinates. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, palette: Palette): void {
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
  }
  ctx.restore();
}
