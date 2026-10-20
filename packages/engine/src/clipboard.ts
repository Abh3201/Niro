import {
  effectiveParents,
  indexesAbove,
  newShapeId,
  readShape,
  type Shape,
  type ShapeId,
  type Tx,
} from "@niro/doc";
import { type Point, unionBoxes } from "./geometry";
import type { Scene } from "./scene";
import { shapeBounds } from "./shapes";
import { frameFor, noteFor, outermost, siblingsIn, unlocked, withDescendants } from "./structure";
import { translate } from "./transform";

/**
 * Copy and paste of shapes, within a board and between boards.
 *
 * What goes on the clipboard is shapes as drawn, on the board: positions
 * are never relative to a frame, and an arrow's ends are where they're
 * drawn. Pasting is then the same problem as merging two documents: every
 * shape gets a new id, and every reference between them (`parentId`, an
 * arrow's `from` and `to`) is pointed at the new ids, or dropped when what
 * it pointed at wasn't copied.
 */

/** Marks Niro's clipboard data, and its version. */
const FORMAT = "niro/shapes";
const VERSION = 1;
/**
 * Most shapes a paste takes. A board holds 10,000 by default; a clipboard
 * from anywhere else (another site can put anything there) is cut off here.
 */
export const MAX_PASTED_SHAPES = 10_000;

/** What a copy puts on the clipboard. */
export interface Clipping {
  /** The board it was copied from, so a paste can tell whether images need to move. */
  readonly board: string;
  /** In draw order; the copied shapes themselves have no parent. */
  readonly shapes: readonly Shape[];
}

/**
 * `ids`, with everything in them, as a paste needs them: as drawn, in draw
 * order, the outermost ones out of whatever they're in. Reactions stay
 * behind: a copy starts without any.
 */
export function copyShapes(scene: Scene, ids: readonly ShapeId[]): Shape[] {
  const units = new Set(outermost(scene, ids));
  const wanted = new Set(withDescendants(scene, [...units]));
  const result: Shape[] = [];
  for (const shape of scene.ordered()) {
    if (!wanted.has(shape.id)) continue;
    const { reactions: _, ...copy } = shape;
    result.push(units.has(shape.id) ? { ...copy, parentId: null } : copy);
  }
  return result;
}

/** The clipboard text for `clipping`. */
export function serializeClipping(clipping: Clipping): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, ...clipping });
}

/**
 * Reads clipboard text written by `serializeClipping`, or null when it's
 * something else. The text can come from anywhere, so every shape is read
 * the way the document reads one (`readShape`): what can't be drawn is
 * dropped, and nothing else is trusted.
 */
export function parseClipping(text: string): Clipping | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { format, version, board, shapes } = data as Record<string, unknown>;
  if (format !== FORMAT || version !== VERSION || !Array.isArray(shapes)) return null;
  const result: Shape[] = [];
  const seen = new Set<string>();
  for (const raw of shapes.slice(0, MAX_PASTED_SHAPES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const id = (raw as Record<string, unknown>).id;
    if (typeof id !== "string" || seen.has(id)) continue;
    const shape = readShape(id, raw as Record<string, unknown>);
    if (!shape) continue;
    seen.add(id);
    result.push(shape);
  }
  return { board: typeof board === "string" ? board : "", shapes: result };
}

/**
 * Adds copies of `shapes` (from `copyShapes`, as drawn) centered on `at`.
 * Each copied shape that isn't inside another goes into the frame it lands
 * in, on top, or for a stroke or an image, onto the sticky note it lands
 * on (see `noteFor`); the rest keep their places inside the copies. Arrows attach
 * to copies of the shapes they were attached to, or to nothing. `asset`
 * maps an image's file to the one to use here (an image moved between
 * boards may get a new one). Returns the outermost copies, to select.
 */
export function pasteShapes(
  scene: Scene,
  tx: Tx,
  shapes: readonly Shape[],
  at: Point,
  asset: (id: string) => string = (id) => id,
): ShapeId[] {
  // Parents among the pasted shapes only: anything else was left behind.
  const parents = effectiveParents(shapes);
  const children = new Map<string, Shape[]>();
  for (const shape of shapes) {
    const parent = parents.get(shape.id) ?? null;
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), shape]);
  }
  // A group with nothing to draw in it has no place on the board.
  const drawable = new Map<string, boolean>();
  const hasContent = (shape: Shape): boolean => {
    const known = drawable.get(shape.id);
    if (known !== undefined) return known;
    drawable.set(shape.id, false);
    const result =
      shape.type !== "group" || (children.get(shape.id) ?? []).some((child) => hasContent(child));
    drawable.set(shape.id, result);
    return result;
  };
  const kept = shapes.filter(hasContent);
  const box = unionBoxes(kept.filter((s) => s.type !== "group").map(shapeBounds));
  if (!box) return [];
  const dx = at.x - (box.minX + box.maxX) / 2;
  const dy = at.y - (box.minY + box.maxY) / 2;

  const copyId = new Map(kept.map((shape) => [shape.id as string, newShapeId()]));
  const units = kept.filter((shape) => (parents.get(shape.id) ?? null) === null);
  const placed = new Map<string, { parentId: ShapeId | null; index: string }>();
  const byParent = new Map<ShapeId | null, Shape[]>();
  for (const unit of units) {
    const moved = { ...unit, ...translate(unit, dx, dy) };
    const parent = noteFor(scene, moved) ?? frameFor(scene, moved);
    byParent.set(parent, [...(byParent.get(parent) ?? []), unit]);
  }
  for (const [parent, members] of byParent) {
    const keys = indexesAbove(siblingsIn(scene, parent), members.length);
    members.forEach((unit, i) => {
      placed.set(unit.id, { parentId: parent, index: keys[i] as string });
    });
  }
  const remap = (id: ShapeId | null) => (id === null ? null : (copyId.get(id) ?? null));
  for (const shape of kept) {
    const parent = parents.get(shape.id) ?? null;
    tx.add({
      ...unlocked(shape),
      ...translate(shape, dx, dy),
      id: copyId.get(shape.id) as ShapeId,
      parentId: placed.get(shape.id)?.parentId ?? remap(parent as ShapeId | null),
      index: placed.get(shape.id)?.index ?? shape.index,
      from: remap(shape.from),
      to: remap(shape.to),
      ...(shape.asset !== undefined && { asset: asset(shape.asset) }),
    });
  }
  return units.map((unit) => copyId.get(unit.id) as ShapeId);
}
