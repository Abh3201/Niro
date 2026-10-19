import type { Shape, ShapeId } from "@niro/doc";
import { drawShape, type Palette } from "./render";
import type { Scene } from "./scene";
import type { TextLayout } from "./text";

export interface PaintOptions {
  readonly scene: Scene;
  readonly palette: Palette;
  /** Screen pixels per world unit, for leaving out what's too small to see. */
  readonly zoom: number;
  /** `FontMetrics.baseline`. */
  readonly baseline: number;
  /** The text to draw on a shape, laid out; none for a shape whose text isn't shown. */
  textLayout(shape: Shape): TextLayout | undefined;
  /** A freehand stroke's outline. */
  stroke(shape: Shape): Path2D | undefined;
}

/**
 * Draws `list`, in draw order, into `ctx` (set to world coordinates):
 * the board on screen, and exported images. Returns how many were drawn.
 */
export function paintShapes(
  ctx: CanvasRenderingContext2D,
  list: readonly Shape[],
  options: PaintOptions,
): number {
  const { scene, palette, zoom, baseline } = options;
  // Shapes in frames are cut off at each frame's edges. Shapes in the
  // same frames share one list, so the clip changes only between frames.
  let clipped: readonly ShapeId[] = [];
  for (const shape of list) {
    const frames = scene.framesAround(shape.id);
    if (frames !== clipped) {
      if (clipped.length > 0) ctx.restore();
      if (frames.length > 0) {
        ctx.save();
        for (const id of frames) {
          const frame = scene.get(id);
          if (!frame) continue;
          ctx.beginPath();
          ctx.rect(frame.x, frame.y, frame.w, frame.h);
          ctx.clip();
        }
      }
      clipped = frames;
    }
    const layout = options.textLayout(shape);
    const text = layout && { layout, baseline, zoom };
    const stroke = shape.type === "freehand" ? options.stroke(shape) : undefined;
    drawShape(ctx, shape, palette, zoom, { ...(text && { text }), ...(stroke && { stroke }) });
  }
  if (clipped.length > 0) ctx.restore();
  return list.length;
}
