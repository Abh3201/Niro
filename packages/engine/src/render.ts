/** The visible area of the board, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** The subset of the Canvas 2D API the renderer uses, so tests can pass a fake. */
export type DrawContext = Pick<CanvasRenderingContext2D, "clearRect" | "fillRect" | "fillStyle">;

/** P0 placeholder content. Replaced by real shapes from the document in P2. */
export const PLACEHOLDER_RECT = { width: 240, height: 160, color: "#3b82f6" } as const;

/** Draws one frame. Expects the context to already be scaled to CSS pixels. */
export function drawScene(ctx: DrawContext, viewport: Viewport): void {
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  const { width, height, color } = PLACEHOLDER_RECT;
  ctx.fillStyle = color;
  ctx.fillRect((viewport.width - width) / 2, (viewport.height - height) / 2, width, height);
}
