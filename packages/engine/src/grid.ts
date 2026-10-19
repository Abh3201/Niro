import { type Camera, visibleBounds } from "./camera";
import type { Viewport } from "./geometry";

/** Distance between grid dots at 100% zoom, in world units. */
export const GRID_SPACING = 24;

/** Dots never get closer together on screen than this, in CSS pixels. */
export const MIN_DOT_GAP = 12;

/** More dots than any screen holds at MIN_DOT_GAP: past this, coordinates have lost precision. */
const MAX_DOTS = 1_000_000;

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
  // Counted in whole steps rather than by adding `spacing` until past the
  // edge: far from the origin (x = 1e20, from a peer) adding 24 no longer
  // changes the number, and that loop would never end.
  const firstColumn = Math.floor(bounds.minX / spacing);
  const firstRow = Math.floor(bounds.minY / spacing);
  const columns = Math.floor(bounds.maxX / spacing) - firstColumn + 1;
  const rows = Math.floor(bounds.maxY / spacing) - firstRow + 1;
  // Dots are at least MIN_DOT_GAP apart on screen, so this only trips when
  // precision has run out; then there is no grid worth drawing.
  if (!(columns > 0 && rows > 0 && columns * rows <= MAX_DOTS)) return;
  for (let i = 0; i < columns; i++) {
    const sx = ((firstColumn + i) * spacing - camera.x) * camera.zoom;
    for (let j = 0; j < rows; j++) {
      const sy = ((firstRow + j) * spacing - camera.y) * camera.zoom;
      ctx.rect(sx - size / 2, sy - size / 2, size, size);
    }
  }
  ctx.fill();
}
