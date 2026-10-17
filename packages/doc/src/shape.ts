import { nanoid } from "nanoid";
import { isValidIndex } from "./order";

/**
 * Bumped whenever the stored board format changes. Old boards are migrated
 * on load; older versions of Niro open newer boards read-only.
 *
 * 2: text shapes, and text on rectangles, ellipses and sticky notes.
 * 3: freehand strokes, and arrows that can be attached to shapes.
 * 4: groups and frames, with positions inside a frame measured from the frame.
 */
export const SCHEMA_VERSION = 4;

/** Shape ids are generated on the client and never reused. */
export type ShapeId = string & { readonly __brand: "ShapeId" };

export const newShapeId = (): ShapeId => nanoid() as ShapeId;

export const SHAPE_TYPES = [
  "rectangle",
  "ellipse",
  "sticky",
  "line",
  "text",
  "freehand",
  "arrow",
  "group",
  "frame",
] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/** Shapes that hold text: boxes, and frames (their name). Not lines, arrows, strokes or groups. */
export function holdsText(type: ShapeType): boolean {
  return (
    type === "rectangle" ||
    type === "ellipse" ||
    type === "sticky" ||
    type === "text" ||
    type === "frame"
  );
}

/** Groups and frames: the shapes other shapes can belong to, through `parentId`. */
export function isContainer(type: ShapeType): boolean {
  return type === "group" || type === "frame";
}

/** Lines and arrows: two end points rather than a box. */
export function isLinear(type: ShapeType): boolean {
  return type === "line" || type === "arrow";
}

/**
 * `Shape.points` values: a stroke's points are stored as whole numbers from
 * 0 to this across its box, and pressure from 0 to 100. Whole numbers take
 * two or three bytes each in an update; decimals take nine.
 */
export const POINT_SCALE = 10_000;
export const PRESSURE_SCALE = 100;

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
  freehand: "black",
  arrow: "black",
  group: "black",
  // Grey frames are the plain board surface (white, or dark in the dark theme).
  frame: "grey",
};

/** Smallest width and height a box shape can have, in world units. */
export const MIN_SIZE = 1;

/**
 * A shape on the board.
 *
 * Box shapes (rectangle, ellipse, sticky, text, freehand): `(x, y)` is the
 * top-left corner of the unrotated box, `w` and `h` its size, and `rotation`
 * turns the box around its center. A text shape's height follows its text;
 * a freehand stroke's points stretch with its box.
 *
 * Lines and arrows: `(x, y)` is the start point and `(x + w, y + h)` the end
 * point, so `w` and `h` may be negative. `rotation` is always 0; rotating one
 * moves its end points. An arrow end attached to a shape (`from`, `to`)
 * follows it: the stored point is only where that end was last placed.
 *
 * Groups and frames hold other shapes, whose `parentId` points at them. A
 * shape in a frame stores `(x, y)` from the top-left of the innermost frame
 * it's in, so moving a frame writes only the frame; everywhere else, `(x, y)`
 * is on the board. A frame is a box that never rotates. A group has no
 * geometry of its own: it's as big as what's in it, worked out when drawn,
 * and what's stored is ignored. Moving a group moves each shape in it.
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
  /**
   * Group or frame this shape belongs to; `null` means top level. Read it
   * through `effectiveParents`, which ignores parents that aren't groups or
   * frames and breaks cycles.
   */
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
  /**
   * A freehand stroke's points, three numbers each: across and down its box
   * (0 to `POINT_SCALE`) and pen pressure (0 to `PRESSURE_SCALE`). Empty on
   * every other shape. Set when the stroke is added and never changed:
   * moving, resizing and rotating change only the box.
   */
  readonly points: readonly number[];
  /** The shape an arrow's start is attached to, or null. Always null on other shapes. */
  readonly from: ShapeId | null;
  /** The shape an arrow's end is attached to, or null. Always null on other shapes. */
  readonly to: ShapeId | null;
}

/** Fields `Tx.update` can set. Text changes go through `Tx.editText`; points never change. */
export type ShapePatch = Partial<Omit<Shape, "id" | "type" | "text" | "points">>;

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
  const isLine = isLinear(shapeType);

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
  const isArrow = shapeType === "arrow";
  const attached = (value: unknown) =>
    isArrow && typeof value === "string" && value !== id ? (value as ShapeId) : null;

  return {
    id: id as ShapeId,
    type: shapeType,
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    w,
    h,
    rotation: isLine || !rotates(shapeType) ? 0 : normalizeAngle(finite(raw.rotation, 0)),
    parentId: typeof parentId === "string" && parentId !== id ? (parentId as ShapeId) : null,
    index: typeof index === "string" && isValidIndex(index) ? index : "a0",
    color:
      typeof color === "string" && (COLORS as readonly string[]).includes(color)
        ? (color as ColorName)
        : DEFAULT_COLOR[shapeType],
    text: typeof text === "string" && holdsText(shapeType) ? text : "",
    points: shapeType === "freehand" ? readPoints(raw.points) : [],
    from: attached(raw.from),
    to: attached(raw.to),
  };
}

/** Frames and groups stay upright; lines and arrows turn by moving their ends. */
function rotates(type: ShapeType): boolean {
  return type !== "frame" && type !== "group";
}

/** Stroke points as stored, or none when they aren't whole triples of numbers in range. */
function readPoints(raw: unknown): readonly number[] {
  if (!Array.isArray(raw) || raw.length % 3 !== 0) return [];
  const points = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    const max = i % 3 === 2 ? PRESSURE_SCALE : POINT_SCALE;
    points[i] = Math.min(max, Math.max(0, value));
  }
  return points;
}
