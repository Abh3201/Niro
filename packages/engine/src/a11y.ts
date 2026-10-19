import { REACTION_NAMES, type Shape, type ShapeId, type ShapeType } from "@niro/doc";
import type { Scene } from "./scene";
import { shapeBounds } from "./shapes";

/**
 * The board for people who don't use a mouse or can't see it: an order to
 * move through shapes with the keyboard, words for each shape, and a list
 * of shapes a screen reader can read.
 */

const NAMES: Readonly<Record<ShapeType, string>> = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  sticky: "Sticky note",
  line: "Line",
  arrow: "Arrow",
  text: "Text",
  freehand: "Pen stroke",
  group: "Group",
  frame: "Frame",
  image: "Image",
};

/** Longest stretch of a shape's text read out. */
const MAX_TEXT = 80;

/** Words for one shape: what it is, its color, and its text. */
export function describeShape(scene: Scene, id: ShapeId): string {
  const shape = scene.get(id);
  if (!shape) return "";
  if (shape.type === "group") {
    const n = scene.childrenOf(id).length;
    return `Group of ${n} ${n === 1 ? "shape" : "shapes"}`;
  }
  const text = shape.text.replace(/\s+/g, " ").trim();
  const excerpt = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  if (shape.type === "frame") {
    const n = scene.childrenOf(id).length;
    return `Frame${excerpt ? ` "${excerpt}"` : ""}, holding ${n} ${n === 1 ? "shape" : "shapes"}`;
  }
  const color =
    shape.type === "text" || shape.type === "freehand" || shape.type === "image"
      ? ""
      : `, ${shape.color}`;
  return `${NAMES[shape.type]}${color}${excerpt ? `: ${excerpt}` : ""}${describeReactions(shape)}`;
}

/** ", 3 reactions", or nothing. */
function describeReactions(shape: Shape): string {
  let n = 0;
  for (const name of REACTION_NAMES) n += shape.reactions?.[name]?.length ?? 0;
  return n === 0 ? "" : `, ${n} ${n === 1 ? "reaction" : "reactions"}`;
}

/**
 * The shapes a click can pick, in reading order: top to bottom, then left
 * to right, each frame followed by what's in it. A group is one stop: what's
 * in it is reached by stepping in, as with the mouse.
 */
export function readingOrder(scene: Scene): ShapeId[] {
  const result: ShapeId[] = [];
  const visit = (parent: ShapeId | null) => {
    const children = scene
      .childrenOf(parent)
      .map((id) => scene.get(id))
      .filter((s): s is Shape => s !== undefined);
    const top = new Map(children.map((s) => [s.id, shapeBounds(s)]));
    children.sort((a, b) => {
      const ba = top.get(a.id);
      const bb = top.get(b.id);
      if (!ba || !bb) return 0;
      return ba.minY - bb.minY || ba.minX - bb.minX || (a.id < b.id ? -1 : 1);
    });
    for (const shape of children) {
      result.push(shape.id);
      if (shape.type === "frame") visit(shape.id);
    }
  };
  visit(null);
  return result;
}

/** The shape after (`step` 1) or before (-1) `current` in reading order; null past either end. */
export function nextInReadingOrder(
  scene: Scene,
  current: ShapeId | null,
  step: 1 | -1,
): ShapeId | null {
  const order = readingOrder(scene);
  if (order.length === 0) return null;
  if (current === null) return step === 1 ? (order[0] ?? null) : null;
  const at = order.indexOf(current);
  // Something not in the order (inside a group): carry on from its group.
  if (at === -1) {
    for (let up = scene.parentOf(current); up !== null; up = scene.parentOf(up)) {
      if (order.includes(up)) return nextInReadingOrder(scene, up, step);
    }
    return null;
  }
  return order[at + step] ?? null;
}

/** Most shapes the screen-reader list holds; past that it says how many more there are. */
const MAX_LISTED = 500;
/** Wait after the last change before rewriting the list, in ms. */
const LIST_DELAY = 400;

/**
 * A list of the board's shapes, in reading order, that screen readers can
 * browse and sighted people never see, placed after `container`. Rewritten a moment after changes
 * stop, rather than on every frame of a drag.
 */
export class ShapeList {
  readonly element: HTMLElement;
  private readonly list: HTMLUListElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
  ) {
    this.element = document.createElement("section");
    this.element.setAttribute("aria-label", "Shapes on the board");
    this.element.dataset.testid = "shape-list";
    Object.assign(this.element.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
    });
    this.list = document.createElement("ul");
    this.element.append(this.list);
    // Next to the board, not in it: a screen reader doesn't read inside an
    // application, which the board is.
    if (container.parentElement) container.after(this.element);
    else container.append(this.element);
    this.write();
  }

  /** Notes that the board changed. */
  changed(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, LIST_DELAY);
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.element.remove();
  }

  private write(): void {
    const order = readingOrder(this.scene);
    const items = order.slice(0, MAX_LISTED).map((id) => {
      const item = document.createElement("li");
      item.textContent = describeShape(this.scene, id);
      return item;
    });
    if (order.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "The board is empty";
      items.push(empty);
    } else if (order.length > MAX_LISTED) {
      const more = document.createElement("li");
      more.textContent = `and ${order.length - MAX_LISTED} more`;
      items.push(more);
    }
    this.list.replaceChildren(...items);
  }
}
