import type { Box, Point, Viewport } from "./geometry";

/**
 * Where the board is looked at from.
 *
 * `x` and `y` are the world coordinates shown at the top-left corner of the
 * viewport, and `zoom` is how many screen pixels one world unit covers. So:
 *
 *   screen = (world - camera) * zoom
 *   world  = screen / zoom + camera
 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/** Zoom levels the zoom buttons and keyboard shortcuts step through. */
export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(camera: Camera, point: Point): Point {
  return { x: point.x / camera.zoom + camera.x, y: point.y / camera.zoom + camera.y };
}

export function worldToScreen(camera: Camera, point: Point): Point {
  return { x: (point.x - camera.x) * camera.zoom, y: (point.y - camera.y) * camera.zoom };
}

/**
 * Zooms to `zoom` while keeping the world point under `screenPoint` exactly
 * where it is on screen. This is what makes zooming feel anchored to the cursor.
 *
 * Derivation: the world point under the cursor is w = s / z0 + c0. After zooming
 * we need s / z1 + c1 = w, so c1 = w - s / z1.
 */
export function zoomAt(camera: Camera, screenPoint: Point, zoom: number): Camera {
  const z = clampZoom(zoom);
  const anchor = screenToWorld(camera, screenPoint);
  return { x: anchor.x - screenPoint.x / z, y: anchor.y - screenPoint.y / z, zoom: z };
}

/** Moves the view by a distance measured in screen pixels (the content follows the pointer). */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom, zoom: camera.zoom };
}

/** A camera that shows `worldPoint` at the center of the viewport. */
export function centerOn(worldPoint: Point, viewport: Viewport, zoom = 1): Camera {
  const z = clampZoom(zoom);
  return {
    x: worldPoint.x - viewport.width / 2 / z,
    y: worldPoint.y - viewport.height / 2 / z,
    zoom: z,
  };
}

/** The part of the world that is currently visible. */
export function visibleBounds(camera: Camera, viewport: Viewport): Box {
  return {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + viewport.width / camera.zoom,
    maxY: camera.y + viewport.height / camera.zoom,
  };
}

/** The next zoom step above (`direction` 1) or below (-1) the current zoom. */
export function nextZoomStep(zoom: number, direction: 1 | -1): number {
  const epsilon = 1e-9;
  if (direction === 1) {
    return ZOOM_STEPS.find((step) => step > zoom + epsilon) ?? MAX_ZOOM;
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - epsilon) ?? MIN_ZOOM;
}

/**
 * Converts a wheel event's vertical delta into a zoom multiplier.
 * Trackpad pinches arrive as small ctrl+wheel deltas, mouse wheels as large ones;
 * the exponential keeps both smooth and makes zooming in then out return exactly.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-100, Math.min(100, pixels));
  return Math.exp(-clamped * 0.01);
}
