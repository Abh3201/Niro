/** P1 placeholder content, centered on the world origin. Replaced by real shapes in P2. */
export const PLACEHOLDER_RECT = {
  x: -120,
  y: -80,
  width: 240,
  height: 160,
  color: "#3b82f6",
} as const;

/** Draws the scene. Expects the context to be transformed to world coordinates. */
export function drawScene(ctx: Pick<CanvasRenderingContext2D, "fillRect" | "fillStyle">): void {
  const { x, y, width, height, color } = PLACEHOLDER_RECT;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}
