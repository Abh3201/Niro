import { holdsText, type Shape, type ShapeId } from "@niro/doc";
import type { Scene } from "./scene";
import { shapeBounds } from "./shapes";

/** Matches past this many are left out: a list of thousands helps nobody, and a query this loose isn't looking for one. */
export const MAX_SEARCH_RESULTS = 500;

/** Case and runs of whitespace don't matter: "Next  Steps" is found by "next steps". */
const normalize = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, " ");

/**
 * The shapes whose text contains `query` (a frame's name counts, and so does
 * text inside groups), top to bottom and then left to right, so stepping
 * through the results walks the board the way you read it. An empty or
 * blank query finds nothing.
 */
export function searchShapes(scene: Scene, query: string): ShapeId[] {
  const wanted = normalize(query).trim();
  if (wanted === "") return [];
  const found: Array<{ shape: Shape; minX: number; minY: number }> = [];
  for (const shape of scene.ordered()) {
    if (!holdsText(shape.type) || shape.text === "") continue;
    if (!normalize(shape.text).includes(wanted)) continue;
    const { minX, minY } = shapeBounds(shape);
    found.push({ shape, minX, minY });
  }
  found.sort((a, b) => a.minY - b.minY || a.minX - b.minX || (a.shape.id < b.shape.id ? -1 : 1));
  return found.slice(0, MAX_SEARCH_RESULTS).map((f) => f.shape.id);
}
