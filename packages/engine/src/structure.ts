import {
  type ColorName,
  DEFAULT_COLOR,
  indexesAbove,
  indexesBelow,
  indexesBetween,
  isLinear,
  newShapeId,
  reorderStep,
  reorderToEnd,
  type Shape,
  type ShapeId,
  type ShapePatch,
  type Tx,
} from "@niro/doc";
import { asDrawn, detachUnless } from "./arrows";
import { type Box, boxContainsBox, boxesIntersect, unionBoxes } from "./geometry";
import type { Scene } from "./scene";
import { lineEnds, shapeBounds, shapeCenter } from "./shapes";
import { translate } from "./transform";

/**
 * Edits to the tree of groups and frames, worked out from the scene.
 *
 * Every shape stores where it is on the board, not where it is in its
 * parent, so these edits are of two kinds: membership (`parentId`, and an
 * `index` among new siblings) and geometry written to every shape inside
 * something that moves.
 */

const shapesOf = (scene: Scene, ids: Iterable<ShapeId>): Shape[] => {
  const result: Shape[] = [];
  for (const id of ids) {
    const shape = scene.get(id);
    if (shape) result.push(shape);
  }
  return result;
};

/** The shapes directly in `parent` (the top level for null), in draw order. */
export function siblingsIn(scene: Scene, parent: ShapeId | null): Shape[] {
  return shapesOf(scene, scene.childrenOf(parent));
}

/**
 * What a click on shape `id` selects. A shape in a group selects the group
 * (the outermost one, below any frame), unless the selection is already
 * inside one of those groups: then it selects at that level, so a double
 * click can step into a group and later clicks stay there.
 */
export function selectableUnit(scene: Scene, id: ShapeId, selection: readonly ShapeId[]): ShapeId {
  const chain = [id];
  for (let at = scene.parentOf(id); at !== null; at = scene.parentOf(at)) {
    if (scene.get(at)?.type !== "group") break;
    chain.push(at);
  }
  const entered = new Set(selection.map((s) => scene.parentOf(s)));
  // chain[i + 1] is chain[i]'s group: stop at the innermost group already entered.
  for (let i = 0; i < chain.length - 1; i++) {
    if (entered.has(chain[i + 1] as ShapeId)) return chain[i] as ShapeId;
  }
  return chain[chain.length - 1] as ShapeId;
}

/** The child of group `group` on the way down to shape `id`: one level into the group. */
export function stepInto(scene: Scene, group: ShapeId, id: ShapeId): ShapeId | null {
  for (let at: ShapeId | null = id; at !== null; at = scene.parentOf(at)) {
    if (scene.parentOf(at) === group) return at;
  }
  return null;
}

/** `ids` without those inside another of `ids`: what an edit to all of them acts on. */
export function outermost(scene: Scene, ids: Iterable<ShapeId>): ShapeId[] {
  const set = new Set(ids);
  return [...set].filter((id) => !scene.ancestorsOf(id).some((a) => set.has(a)));
}

/** `ids` and everything inside them, each once. */
export function withDescendants(scene: Scene, ids: Iterable<ShapeId>): ShapeId[] {
  const result = new Set<ShapeId>();
  for (const id of outermost(scene, ids)) {
    result.add(id);
    for (const d of scene.descendantsOf(id)) result.add(d);
  }
  return [...result];
}

/**
 * The shapes moving `ids` writes: each one, or for a group, what's in it (a
 * group has no position of its own). What's in a frame isn't written: it's
 * stored where it is in the frame, so it follows the frame.
 */
export function movers(scene: Scene, ids: Iterable<ShapeId>): ShapeId[] {
  const result: ShapeId[] = [];
  const visit = (id: ShapeId) => {
    if (scene.get(id)?.type !== "group") result.push(id);
    else for (const child of scene.childrenOf(id)) visit(child);
  };
  for (const id of outermost(scene, ids)) visit(id);
  return result;
}

/**
 * The shapes a style change (a color) applies to: groups stand for what's
 * in them, while a frame is recolored itself, not its contents.
 */
export function styleTargets(scene: Scene, ids: Iterable<ShapeId>): ShapeId[] {
  const result: ShapeId[] = [];
  const visit = (id: ShapeId) => {
    if (scene.get(id)?.type === "group") for (const child of scene.childrenOf(id)) visit(child);
    else result.push(id);
  };
  for (const id of outermost(scene, ids)) visit(id);
  return result;
}

/** The color every shape a style change would touch shares, or null when they differ. */
export function sharedColor(scene: Scene, ids: Iterable<ShapeId>): ColorName | null {
  let color: ColorName | null = null;
  for (const shape of shapesOf(scene, styleTargets(scene, ids))) {
    if (color !== null && shape.color !== color) return null;
    color = shape.color;
  }
  return color;
}

/**
 * The frame a shape belongs in where it is now, other than those in
 * `exclude`: the one under its center, or for a line or arrow, the one
 * both its ends are in (an arrow from inside a frame to outside it isn't
 * cut off at the frame's edge).
 */
export function frameFor(
  scene: Scene,
  shape: Shape,
  exclude: ReadonlySet<ShapeId> = new Set(),
): ShapeId | null {
  if (!isLinear(shape.type)) return scene.frameAt(shapeCenter(shape), exclude);
  const [a, b] = lineEnds(shape);
  const frame = scene.frameAt(a, exclude);
  return frame === scene.frameAt(b, exclude) ? frame : null;
}

/** A key for shape `id` joining `parent`: on top, or for a frame, at the bottom. */
function joinKey(scene: Scene, parent: ShapeId | null, id: ShapeId): string {
  const siblings = siblingsIn(scene, parent).filter((s) => s.id !== id);
  const [key] =
    scene.get(id)?.type === "frame" ? indexesBelow(siblings, 1) : indexesAbove(siblings, 1);
  return key as string;
}

/**
 * Membership changes for `units`, shapes as they were when a move started,
 * moved by `(dx, dy)`: each that lands in a frame joins it, on top, and one
 * dragged out of its frame leaves it. Shapes in a group stay in their group.
 * `moving` is everything that moves, which can't be a destination.
 */
export function reparentOnMove(
  scene: Scene,
  units: readonly Shape[],
  moving: ReadonlySet<ShapeId>,
  dx: number,
  dy: number,
): Map<ShapeId, ShapePatch> {
  const joining = new Map<ShapeId | null, ShapeId[]>();
  for (const unit of units) {
    const parent = scene.parentOf(unit.id);
    if (!scene.has(unit.id) || (parent !== null && scene.get(parent)?.type === "group")) continue;
    const target = frameFor(scene, { ...unit, ...translate(unit, dx, dy) }, moving);
    if (target === parent) continue;
    joining.set(target, [...(joining.get(target) ?? []), unit.id]);
  }
  const patches = new Map<ShapeId, ShapePatch>();
  for (const [target, ids] of joining) {
    const keys = indexesAbove(
      siblingsIn(scene, target).filter((s) => !moving.has(s.id)),
      ids.length,
    );
    ids.forEach((id, i) => {
      patches.set(id, { parentId: target, index: keys[i] as string });
    });
  }
  return patches;
}

/** Where a new shape goes: in the frame it's in, on top, or for a new frame, at the bottom. */
export function placeNew(scene: Scene, shape: Shape): Pick<Shape, "parentId" | "index"> {
  const parentId = frameFor(scene, shape, new Set([shape.id]));
  const siblings = siblingsIn(scene, parentId);
  const [index] = shape.type === "frame" ? indexesBelow(siblings, 1) : indexesAbove(siblings, 1);
  return { parentId, index: index as string };
}

/**
 * Moves a shape just drawn into the frame it ended up in, if that's not
 * where it started: a line drawn out of a frame leaves it.
 */
export function settleNew(scene: Scene, tx: Tx, id: ShapeId): void {
  const shape = scene.get(id);
  if (!shape) return;
  const parentId = frameFor(scene, shape, new Set([id]));
  if (parentId === scene.parentOf(id)) return;
  tx.update(id, { parentId, index: joinKey(scene, parentId, id) });
}

/** A new frame takes in the shapes beside it that lie entirely inside it. */
export function adoptInto(scene: Scene, tx: Tx, frameId: ShapeId): void {
  const frame = scene.get(frameId);
  if (!frame) return;
  const box = shapeBounds(frame);
  for (const sibling of siblingsIn(scene, scene.parentOf(frameId))) {
    if (sibling.id !== frameId && boxContainsBox(box, shapeBounds(sibling)))
      tx.update(sibling.id, { parentId: frameId });
  }
}

/** A frame resized away from shapes in it lets go of those now entirely outside it. */
export function releaseOutside(scene: Scene, tx: Tx, frameId: ShapeId): void {
  const frame = scene.get(frameId);
  if (!frame) return;
  const box = shapeBounds(frame);
  const outside = siblingsIn(scene, frameId).filter((child) => {
    return !boxesIntersect(box, shapeBounds(child));
  });
  if (outside.length === 0) return;
  const parent = scene.parentOf(frameId);
  const keys = indexesAbove(siblingsIn(scene, parent), outside.length);
  outside.forEach((child, i) => {
    tx.update(child.id, { parentId: parent, index: keys[i] as string });
  });
}

/**
 * Puts `ids` in a new group, where the topmost of them was drawn, in the
 * innermost group or frame that holds them all. Returns the group's id, or
 * null for fewer than two shapes.
 */
export function group(scene: Scene, tx: Tx, ids: readonly ShapeId[]): ShapeId | null {
  const units = outermost(scene, ids).filter((id) => scene.has(id));
  if (units.length < 2) return null;
  const rank = new Map(scene.ordered().map((shape, i) => [shape.id, i]));
  units.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  const top = units[units.length - 1] as ShapeId;
  const holds = (container: ShapeId | null, id: ShapeId) =>
    container === null || scene.ancestorsOf(id).includes(container);
  const parentId =
    [...scene.ancestorsOf(top), null].find((container) =>
      units.every((id) => holds(container, id)),
    ) ?? null;
  // The group goes just above the topmost shape (or the shape holding it) in that parent.
  const anchor = [top, ...scene.ancestorsOf(top)].find((id) => scene.parentOf(id) === parentId);
  const siblings = scene.childrenOf(parentId);
  const above = siblings[siblings.indexOf(anchor as ShapeId) + 1];
  const [index] = indexesBetween(
    scene.get(anchor as ShapeId)?.index ?? null,
    above === undefined ? null : (scene.get(above)?.index ?? null),
    1,
  );
  const id = newShapeId();
  tx.add({
    id,
    type: "group",
    // A group's box is worked out from what's in it; nothing here is read.
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    parentId,
    index: index as string,
    color: DEFAULT_COLOR.group,
    text: "",
    points: [],
    from: null,
    to: null,
  });
  // New keys in the order they're drawn: they may come from different parents.
  const keys = indexesBetween(null, null, units.length);
  units.forEach((unit, i) => {
    tx.update(unit, { parentId: id, index: keys[i] as string });
  });
  return id;
}

/**
 * Dissolves the groups among `ids`: what was in each takes its place among
 * its siblings, in the same order. Returns what should be selected after:
 * the freed shapes, and anything in `ids` that wasn't a group.
 */
export function ungroup(scene: Scene, tx: Tx, ids: readonly ShapeId[]): ShapeId[] {
  const selection: ShapeId[] = [];
  for (const id of outermost(scene, ids)) {
    const shape = scene.get(id);
    if (shape?.type !== "group") {
      selection.push(id);
      continue;
    }
    const parent = scene.parentOf(id);
    const siblings = scene.childrenOf(parent);
    const next = scene.get(siblings[siblings.indexOf(id) + 1] as ShapeId);
    const children = scene.childrenOf(id);
    const keys = indexesBetween(shape.index, next?.index ?? null, children.length);
    children.forEach((child, i) => {
      tx.update(child, { parentId: parent, index: keys[i] as string });
    });
    tx.remove(id);
    selection.push(...children);
  }
  return selection;
}

/**
 * Deletes `ids` and everything in them. Arrows attached to deleted shapes
 * stay where they're drawn, and groups left empty go too.
 */
export function remove(scene: Scene, tx: Tx, ids: readonly ShapeId[]): void {
  const deleted = new Set(withDescendants(scene, ids));
  // Walk up: a group whose every child is going goes as well.
  for (const id of [...deleted]) {
    for (const ancestor of scene.ancestorsOf(id)) {
      if (deleted.has(ancestor) || scene.get(ancestor)?.type !== "group") break;
      if (!scene.childrenOf(ancestor).every((child) => deleted.has(child))) break;
      deleted.add(ancestor);
    }
  }
  for (const id of deleted) {
    for (const arrowId of scene.arrowsAttachedTo(id)) {
      const arrow = scene.get(arrowId);
      if (arrow && !deleted.has(arrowId))
        tx.update(arrowId, {
          ...asDrawn(arrow),
          ...detachUnless(arrow, (target) => !deleted.has(target)),
        });
    }
  }
  for (const id of deleted) tx.remove(id);
}

/**
 * Copies `ids`, with everything in them, `offset` down and right. Copies of
 * shapes go on top of their originals' siblings; arrows attach to copies of
 * the shapes they were attached to, or to nothing. Returns the copies of
 * `ids`, to select.
 */
export function duplicate(
  scene: Scene,
  tx: Tx,
  ids: readonly ShapeId[],
  offset: number,
): ShapeId[] {
  const units = outermost(scene, ids);
  const all = withDescendants(scene, units);
  const copyId = new Map(all.map((id) => [id, newShapeId()]));
  const unitKeys = new Map<ShapeId, string>();
  const byParent = new Map<ShapeId | null, ShapeId[]>();
  const rank = new Map(scene.ordered().map((shape, i) => [shape.id, i]));
  for (const unit of [...units].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))) {
    const parent = scene.parentOf(unit);
    byParent.set(parent, [...(byParent.get(parent) ?? []), unit]);
  }
  for (const [parent, members] of byParent) {
    const keys = indexesAbove(siblingsIn(scene, parent), members.length);
    members.forEach((unit, i) => {
      unitKeys.set(unit, keys[i] as string);
    });
  }
  const remap = (id: ShapeId | null) => (id === null ? null : (copyId.get(id) ?? null));
  for (const shape of shapesOf(scene, all)) {
    const parent = scene.parentOf(shape.id);
    tx.add({
      ...shape,
      ...translate(shape, offset, offset),
      id: copyId.get(shape.id) as ShapeId,
      parentId: copyId.get(parent as ShapeId) ?? parent,
      index: unitKeys.get(shape.id) ?? shape.index,
      from: remap(shape.from),
      to: remap(shape.to),
    });
  }
  return units.map((id) => copyId.get(id) as ShapeId);
}

/**
 * New indexes for moving `ids` forward, backward, to the front or to the
 * back, each among its own siblings.
 */
export function reorder(
  scene: Scene,
  ids: readonly ShapeId[],
  direction: "forward" | "backward" | "front" | "back",
): Map<ShapeId, string> {
  const byParent = new Map<ShapeId | null, Set<string>>();
  for (const id of outermost(scene, ids)) {
    const parent = scene.parentOf(id);
    const set = byParent.get(parent) ?? new Set<string>();
    set.add(id);
    byParent.set(parent, set);
  }
  const result = new Map<ShapeId, string>();
  for (const [parent, selected] of byParent) {
    const siblings = siblingsIn(scene, parent);
    const keys =
      direction === "forward" || direction === "backward"
        ? reorderStep(siblings, selected, direction === "forward" ? 1 : -1)
        : reorderToEnd(siblings, selected, direction === "front" ? 1 : -1);
    for (const [id, index] of keys) result.set(id as ShapeId, index);
  }
  return result;
}

/** The box around `ids` as drawn, or null when there's nothing. */
export function boundsOf(scene: Scene, ids: Iterable<ShapeId>): Box | null {
  return unionBoxes(shapesOf(scene, ids).map(shapeBounds));
}
