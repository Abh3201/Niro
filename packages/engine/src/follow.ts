import { type Camera, clampZoom } from "./camera";
import type { Viewport } from "./geometry";

/**
 * Following someone: this client's camera shows what theirs does. They
 * share the part of the board they see (`View`, world coordinates), not
 * their camera: screens differ in size, so the follower fits that part in
 * their own, centered, and may see more of the board around it.
 */

/** The part of the board someone sees, in world coordinates. */
export interface View {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** How quickly the camera closes on where it's going, in ms: after this long it has covered about 63%. */
export const FOLLOW_SMOOTHING_MS = 90;

/** The camera that shows all of `view` in `viewport`, or null when either has no area. */
export function followCamera(view: View, viewport: Viewport): Camera | null {
  if (!(view.w > 0 && view.h > 0 && viewport.width > 0 && viewport.height > 0)) return null;
  const zoom = clampZoom(Math.min(viewport.width / view.w, viewport.height / view.h));
  return {
    x: view.x + view.w / 2 - viewport.width / 2 / zoom,
    y: view.y + view.h / 2 - viewport.height / 2 / zoom,
    zoom,
  };
}

/**
 * A step from `from` toward `to` after `elapsedMs`. Zoom is eased by ratio,
 * so zooming in and out feel alike. Lands on `to` once it is under half a
 * pixel off.
 */
export function easeCamera(from: Camera, to: Camera, elapsedMs: number): Camera {
  const k = 1 - Math.exp(-elapsedMs / FOLLOW_SMOOTHING_MS);
  const zoom = from.zoom * (to.zoom / from.zoom) ** k;
  const next = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, zoom };
  const pixels = Math.hypot(to.x - next.x, to.y - next.y) * zoom;
  return pixels < 0.5 && Math.abs(to.zoom / zoom - 1) < 0.002 ? to : next;
}
