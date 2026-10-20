import { nanoid } from "nanoid";
import { isValidIndex } from "./order";
import { readRuns, type TextRun } from "./text-runs";

/**
 * Bumped whenever the stored board format changes. Old boards are migrated
 * on load; older versions of Niro open newer boards read-only.
 *
 * 2: text shapes, and text on rectangles, ellipses and sticky notes.
 * 3: freehand strokes, and arrows that can be attached to shapes.
 * 4: groups and frames, with positions inside a frame measured from the frame.
 * 5: images, and emoji reactions on shapes.
 * 6: locked shapes, and line styles (dashes, thickness, arrowheads).
 * 7: pen strokes can belong to the sticky note they were drawn on.
 * 8: arrows can be routed with right angles (elbow arrows).
 * 9: text formatting: font, size, bold, italic, underline, strikethrough,
 *    alignment and text color, per shape.
 * 10: formatting on parts of a shape's text (`textRuns`), and paragraph
 *    alignment, stored as Y.Text formatting attributes.
 */
export const SCHEMA_VERSION = 10;

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
  "image",
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

/**
 * Shapes whose text can be formatted (font, size, alignment and so on):
 * those that hold text, except frames, whose name is always set the same.
 */
export function takesTextStyle(type: ShapeType): boolean {
  return type === "rectangle" || type === "ellipse" || type === "sticky" || type === "text";
}

/** Text shapes are set in the shape's own color; boxes have a text color of their own. */
export function hasTextColor(type: ShapeType): boolean {
  return type === "rectangle" || type === "ellipse" || type === "sticky";
}

/**
 * Typefaces, by name. Each is a list of fonts already on people's
 * computers (no web fonts to download), so text measures the same before
 * and after a font arrives, and exports need nothing embedded. Absent means
 * sans, the system's own font.
 */
export const FONTS = ["sans", "serif", "mono", "hand"] as const;
export type FontName = (typeof FONTS)[number];

/** Smallest and largest font size that can be set, in world units. */
export const MIN_FONT_SIZE = 4;
export const MAX_FONT_SIZE = 400;
/**
 * A text's font size: a number of world units, or `"auto"`, the default
 * (a text shape's usual 24, a box's text shrinking to fit). In a box, a
 * number is the largest size: text that doesn't fit still shrinks.
 */
export type FontSize = number | "auto";

/** How lines sit across the text's box. Absent means left for text shapes, center for the rest. */
export const ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof ALIGNS)[number];
export const defaultAlign = (type: ShapeType): TextAlign => (type === "text" ? "left" : "center");

/** Where a box's text sits, top to bottom. Absent means middle. Text shapes grow to fit, so have none. */
export const VALIGNS = ["top", "middle", "bottom"] as const;
export type VerticalAlign = (typeof VALIGNS)[number];

/** A box's text color: a color name, or `"auto"`, the default (dark or white, whichever reads on the fill). */
export type TextColor = ColorName | "auto";

/**
 * Groups, frames and sticky notes: the shapes other shapes can belong to,
 * through `parentId`. Only pen strokes and images belong to a sticky note,
 * and they keep their board position (see docs/decisions/0009-ink-on-notes.md).
 */
export function isContainer(type: ShapeType): boolean {
  return type === "group" || type === "frame" || type === "sticky";
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

/** How a line or arrow is dashed. Absent means solid. */
export const DASHES = ["solid", "dashed", "dotted"] as const;
export type LineDash = (typeof DASHES)[number];

/** How thick a line or arrow is drawn. Absent means medium. */
export const THICKNESSES = ["thin", "medium", "thick"] as const;
export type LineThickness = (typeof THICKNESSES)[number];

/**
 * How an arrow is routed: straight between its ends, or with right angles
 * around the shapes it connects. Absent means straight.
 */
export const ROUTES = ["straight", "elbow"] as const;
export type LineRoute = (typeof ROUTES)[number];

/**
 * Where a line or arrow has a head. Absent means the end for an arrow and
 * none for a line.
 */
export const HEADS = ["none", "end", "start", "both"] as const;
export type LineHead = (typeof HEADS)[number];

/** The heads a line or arrow has when none are stored. */
export const defaultHead = (type: ShapeType): LineHead => (type === "arrow" ? "end" : "none");

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
  // Images have no color of their own.
  image: "grey",
};

/**
 * The reactions anyone can put on a shape, stored by name so the stored
 * value never depends on how an emoji is encoded.
 */
export const REACTIONS = {
  like: "👍",
  love: "❤️",
  laugh: "😂",
  party: "🎉",
  wow: "😮",
  eyes: "👀",
} as const;
export type ReactionName = keyof typeof REACTIONS;
export const REACTION_NAMES = Object.keys(REACTIONS) as ReactionName[];

/**
 * Who reacted to a shape, by reaction, in `REACTION_NAMES` order; a
 * reaction nobody gave is left out. Ids are each browser's own random id
 * (there are no accounts), sorted.
 */
export type Reactions = Readonly<Partial<Record<ReactionName, readonly string[]>>>;

/** A browser's id, as reactions store it. */
export const USER_ID = /^[A-Za-z0-9_-]{8,32}$/;

/**
 * Key in a shape's stored fields for one person's reaction. One key per
 * person and reaction means adding and removing your own can never undo
 * someone else's, whatever order the changes arrive in.
 */
export const reactionKey = (reaction: ReactionName, user: string): string =>
  `reaction.${reaction}.${user}`;

/**
 * Images are stored apart from the board (the board holds only this id):
 * the SHA-256 of the file's bytes, in hex.
 */
export const ASSET_ID = /^[0-9a-f]{64}$/;

/** Most people whose reactions are read per shape: past it, a hostile client could freeze every tab. */
const MAX_REACTIONS = 1_000;

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
  /** An image's file (see `ASSET_ID`). Only on images, set when added and never changed. */
  readonly asset?: string;
  /** Emoji reactions, when there are any. Changed with `Tx.react`. */
  readonly reactions?: Reactions;
  /**
   * The shape (and what's in it) can't be moved, resized, restyled or
   * deleted until it's unlocked. Only present when true. A guard against
   * accidents, not a permission: everyone with an edit link can unlock.
   */
  readonly locked?: boolean;
  /** Lines and arrows only; present only when not the default (solid, medium, the type's usual heads). */
  readonly dash?: LineDash;
  readonly thickness?: LineThickness;
  readonly head?: LineHead;
  /** Arrows only; present only when elbow. The path is worked out wherever the arrow is drawn, never stored. */
  readonly route?: LineRoute;
  /**
   * Text formatting, for the whole of a shape's text (`takesTextStyle`
   * shapes only). Each is present only when not the default: sans, auto
   * size, not bold and so on, the type's usual alignment, middle, auto color.
   */
  readonly font?: FontName;
  readonly fontSize?: FontSize;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly align?: TextAlign;
  /** Boxes only (not text shapes). */
  readonly valign?: VerticalAlign;
  /** Boxes only: a text shape's text is in its `color`. */
  readonly textColor?: TextColor;
  /**
   * Formatting on parts of the text, over the fields above, which are the
   * defaults for what isn't formatted (`takesTextStyle` shapes only). Runs
   * cover the whole text in order; absent when no part is formatted. Read
   * from the `Y.Text`'s attributes: change it with `Tx.editText` and
   * `Tx.formatText`, never with `Tx.update`.
   */
  readonly textRuns?: readonly TextRun[];
}

/** Fields `Tx.update` can set. Text changes go through `Tx.editText` and `Tx.formatText`, reactions through `Tx.react`; points and assets never change. */
export type ShapePatch = Partial<
  Omit<Shape, "id" | "type" | "text" | "textRuns" | "points" | "asset" | "reactions">
>;

const TAU = Math.PI * 2;

export function normalizeAngle(radians: number): number {
  const r = radians % TAU;
  return r < 0 ? r + TAU : r;
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Furthest a position or size may be from zero, in world units: thousands of
 * times any real board, and far enough inside double precision that adding
 * a pixel still changes the number (at 1e20 it doesn't, and loops that step
 * across the screen never end).
 */
export const MAX_COORDINATE = 1e9;

const coordinate = (value: unknown, fallback: number): number =>
  Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, finite(value, fallback)));

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

  let w = coordinate(raw.w, 100);
  let h = coordinate(raw.h, 100);
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
  const asset = raw.asset;
  const reactions = readReactions(raw);
  const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
    typeof value === "string" && (list as readonly string[]).includes(value)
      ? (value as T)
      : undefined;
  const dash = isLine ? oneOf(DASHES, raw.dash) : undefined;
  const thickness = isLine ? oneOf(THICKNESSES, raw.thickness) : undefined;
  const head = isLine ? oneOf(HEADS, raw.head) : undefined;
  const route = isArrow ? oneOf(ROUTES, raw.route) : undefined;
  const styled = takesTextStyle(shapeType);
  const boxed = hasTextColor(shapeType);
  const font = styled ? oneOf(FONTS, raw.font) : undefined;
  const fontSize =
    styled && typeof raw.fontSize === "number" && Number.isFinite(raw.fontSize)
      ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, raw.fontSize))
      : undefined;
  const align = styled ? oneOf(ALIGNS, raw.align) : undefined;
  const valign = boxed ? oneOf(VALIGNS, raw.valign) : undefined;
  const textColor = boxed ? oneOf(COLORS, raw.textColor) : undefined;
  const flag = (value: unknown) => styled && value === true;
  const shapeText = typeof text === "string" && holdsText(shapeType) ? text : "";
  const textRuns = styled ? readRuns(raw.textRuns, shapeText.length) : undefined;

  return {
    id: id as ShapeId,
    type: shapeType,
    x: coordinate(raw.x, 0),
    y: coordinate(raw.y, 0),
    w,
    h,
    rotation: isLine || !rotates(shapeType) ? 0 : normalizeAngle(finite(raw.rotation, 0)),
    parentId: typeof parentId === "string" && parentId !== id ? (parentId as ShapeId) : null,
    index: typeof index === "string" && isValidIndex(index) ? index : "a0",
    color:
      typeof color === "string" && (COLORS as readonly string[]).includes(color)
        ? (color as ColorName)
        : DEFAULT_COLOR[shapeType],
    text: shapeText,
    points: shapeType === "freehand" ? readPoints(raw.points) : [],
    from: attached(raw.from),
    to: attached(raw.to),
    ...(shapeType === "image" && {
      asset: typeof asset === "string" && ASSET_ID.test(asset) ? asset : "",
    }),
    ...(reactions && { reactions }),
    ...(raw.locked === true && { locked: true }),
    ...(dash && dash !== "solid" && { dash }),
    ...(thickness && thickness !== "medium" && { thickness }),
    ...(head && head !== defaultHead(shapeType) && { head }),
    ...(route && route !== "straight" && { route }),
    ...(font && font !== "sans" && { font }),
    ...(fontSize !== undefined && { fontSize }),
    ...(flag(raw.bold) && { bold: true }),
    ...(flag(raw.italic) && { italic: true }),
    ...(flag(raw.underline) && { underline: true }),
    ...(flag(raw.strike) && { strike: true }),
    ...(align && align !== defaultAlign(shapeType) && { align }),
    ...(valign && valign !== "middle" && { valign }),
    ...(textColor && { textColor }),
    ...(textRuns && { textRuns }),
  };
}

/** The reactions in a shape's stored fields, or undefined when there are none. */
function readReactions(raw: Readonly<Record<string, unknown>>): Reactions | undefined {
  let found: Partial<Record<ReactionName, string[]>> | undefined;
  let count = 0;
  for (const key in raw) {
    if (!key.startsWith("reaction.") || raw[key] !== true) continue;
    const dot = key.indexOf(".", 9);
    const name = key.slice(9, dot);
    const user = key.slice(dot + 1);
    if (dot < 0 || !Object.hasOwn(REACTIONS, name) || !USER_ID.test(user)) continue;
    if (++count > MAX_REACTIONS) break;
    found ??= {};
    const users = found[name as ReactionName];
    if (users) users.push(user);
    else found[name as ReactionName] = [user];
  }
  if (!found) return undefined;
  const sorted: Partial<Record<ReactionName, readonly string[]>> = {};
  for (const name of REACTION_NAMES) {
    const users = found[name];
    if (users) sorted[name] = users.sort();
  }
  return sorted;
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
