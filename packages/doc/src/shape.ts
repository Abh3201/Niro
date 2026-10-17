import { nanoid } from "nanoid";
import { isValidIndex } from "./order";

/**
 * Bumped whenever the stored board format changes. Old boards are migrated
 * on load; older versions of Niro open newer boards read-only.
 *
 * 2: text shapes, and text on rectangles, ellipses and sticky notes.
 */
export const SCHEMA_VERSION = 2;

/** Shape ids are generated on the client and never reused. */
export type ShapeId = string & { readonly __brand: "ShapeId" };

export const newShapeId = (): ShapeId => nanoid() as ShapeId;

export const SHAPE_TYPES = ["rectangle", "ellipse", "sticky", "line", "text"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/** Shapes that hold text. Lines don't. */
export function holdsText(type: ShapeType): boolean {
  return type !== "line";
}

/**
 * Colors are stored by name, not as hex, so each theme (light, dark) can draw
 * them with its own value.
 */
export const COLORS = [
  "black",
  "grey",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "violet",
] as const;
export type ColorName = (typeof COLORS)[number];

export const DEFAULT_COLOR: Record<ShapeType, ColorName> = {
  rectangle: "blue",
  ellipse: "green",
  sticky: "yellow",
  line: "black",
  text: "black",
};

/** Smallest width and height a box shape can have, in world units. */
export const MIN_SIZE = 1;

/**
 * A shape on the board.
 *
 * Box shapes (rectangle, ellipse, sticky, text): `(x, y)` is the top-left
 * corner of the unrotated box, `w` and `h` its size, and `rotation` turns the
 * box around its center. A text shape's height follows its text.
 *
 * Lines: `(x, y)` is the start point and `(x + w, y + h)` the end point, so
 * `w` and `h` may be negative. `rotation` is always 0; rotating a line moves
 * its end points.
 */
export interface Shape {
  readonly id: ShapeId;
  readonly type: ShapeType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Radians, in [0, 2π). */
  readonly rotation: number;
  /** Group or frame this shape belongs to; `null` means top level. */
  readonly parentId: ShapeId | null;
  /** Fractional index: siblings are drawn in `(index, id)` order. */
  readonly index: string;
  readonly color: ColorName;
  /**
   * Plain text, `""` when there is none (always, on lines). Stored as a
   * `Y.Text`, so two people typing in one shape both keep their characters:
   * change it with `Tx.editText`, never by replacing it.
   */
  readonly text: string;
}

/** Fields `Tx.update` can set. Text changes go through `Tx.editText`. */
export type ShapePatch = Partial<Omit<Shape, "id" | "type" | "text">>;

const TAU = Math.PI * 2;

export function normalizeAngle(radians: number): number {
  const r = radians % TAU;
  return r < 0 ? r + TAU : r;
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Turns whatever is stored for a shape into a valid `Shape`, or `null` when it
 * can't be drawn (an unknown type, for example one added by a newer version).
 *
 * The document can contain anything a peer wrote, including older or newer
 * versions of Niro and buggy or hostile clients. Every read goes through
 * here, so the engine can rely on the `Shape` invariants. Nothing is written
 * back: every peer repairs the same stored data the same way.
 */
export function readShape(id: string, raw: Readonly<Record<string, unknown>>): Shape | null {
  const type = raw.type;
  if (typeof type !== "string" || !(SHAPE_TYPES as readonly string[]).includes(type)) return null;
  const shapeType = type as ShapeType;
  const isLine = shapeType === "line";

  let w = finite(raw.w, 100);
  let h = finite(raw.h, 100);
  if (!isLine) {
    w = Math.max(MIN_SIZE, Math.abs(w));
    h = Math.max(MIN_SIZE, Math.abs(h));
  }
  const color = raw.color;
  const index = raw.index;
  const parentId = raw.parentId;
  const text = raw.text;

  return {
    id: id as ShapeId,
    type: shapeType,
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    w,
    h,
    rotation: isLine ? 0 : normalizeAngle(finite(raw.rotation, 0)),
    parentId: typeof parentId === "string" && parentId !== id ? (parentId as ShapeId) : null,
    index: typeof index === "string" && isValidIndex(index) ? index : "a0",
    color:
      typeof color === "string" && (COLORS as readonly string[]).includes(color)
        ? (color as ColorName)
        : DEFAULT_COLOR[shapeType],
    text: typeof text === "string" && holdsText(shapeType) ? text : "",
  };
}
