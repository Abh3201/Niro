import { type Camera, panBy, zoomAt } from "./camera";
import { distance, midpoint, type Point } from "./geometry";

/**
 * Camera after a two-finger gesture moves from `previous` to `next` touch points.
 *
 * The fingers' spread controls zoom (anchored at their midpoint) and the
 * midpoint's movement controls panning, so the world point between the fingers
 * stays between the fingers, like a photo on a phone.
 */
export function pinchCamera(
  camera: Camera,
  previous: readonly [Point, Point],
  next: readonly [Point, Point],
): Camera {
  const previousMid = midpoint(previous[0], previous[1]);
  const nextMid = midpoint(next[0], next[1]);
  const previousSpread = distance(previous[0], previous[1]);
  const scale = previousSpread > 0 ? distance(next[0], next[1]) / previousSpread : 1;

  const zoomed = zoomAt(camera, previousMid, camera.zoom * scale);
  return panBy(zoomed, nextMid.x - previousMid.x, nextMid.y - previousMid.y);
}
