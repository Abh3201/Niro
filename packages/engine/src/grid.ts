import { type Camera, visibleBounds } from "./camera";
import type { Viewport } from "./geometry";

/** Distance between grid dots at 100% zoom, in world units. */
export const GRID_SPACING = 24;

/** Dots never get closer together on screen than this, in CSS pixels. */
export const MIN_DOT_GAP = 12;

/**
 * Grid spacing in world units for a zoom level. When zooming out would pack the
 * dots tighter than MIN_DOT_GAP, every other dot is dropped (spacing doubles).
 */
export function gridSpacing(zoom: number): number {
  let spacing = GRID_SPACING;
  while (spacing * zoom < MIN_DOT_GAP) spacing *= 2;
  return spacing;
}

/**
 * Draws the dot grid in screen space, so dots stay crisp and the same size at
 * every zoom level. Expects the context to be scaled to CSS pixels.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  viewport: Viewport,
  color: string,
): void {
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  const spacing = gridSpacing(camera.zoom);
  const bounds = visibleBounds(camera, viewport);
  const size = 1.5;

  ctx.fillStyle = color;
  ctx.beginPath();
  for (let wx = Math.floor(bounds.minX / spacing) * spacing; wx <= bounds.maxX; wx += spacing) {
    const sx = (wx - camera.x) * camera.zoom;
    for (let wy = Math.floor(bounds.minY / spacing) * spacing; wy <= bounds.maxY; wy += spacing) {
      const sy = (wy - camera.y) * camera.zoom;
      ctx.rect(sx - size / 2, sy - size / 2, size, size);
    }
  }
  ctx.fill();
}
