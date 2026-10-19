/**
 * The board document model.
 *
 * This is a first draft of the contract between the engine and the sync layer.
 * The engine only ever talks to `DocStore`; it never imports Yjs (or Loro). The
 * P2 spike compares both behind this interface and finalizes it.
 */

/** Bumped whenever the stored board format changes. Old boards are migrated on load. */
export const SCHEMA_VERSION = 1;

/** Shape ids are generated on the client and never reused. */
export type ShapeId = string & { readonly __brand: "ShapeId" };

export type ShapeType = "rectangle" | "ellipse" | "sticky" | "line";

export interface Shape {
  id: ShapeId;
  type: ShapeType;
  /** Position and size in world coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in radians, around the shape's center. */
  rotation: number;
  /** Group or frame this shape belongs to; `null` means top level. */
  parentId: ShapeId | null;
  /** Fractional index: siblings are drawn in `(index, id)` order. */
  index: string;
}

/** Who made a change. Undo only reverts `local` changes. */
export type Origin = "local" | "remote";

export type ShapeChange =
  | { kind: "added"; id: ShapeId }
  | { kind: "updated"; id: ShapeId }
  | { kind: "removed"; id: ShapeId };

/** Mutations allowed inside `DocStore.transact`. */
export interface Tx {
  add(shape: Shape): void;
  update(id: ShapeId, patch: Partial<Omit<Shape, "id">>): void;
  remove(id: ShapeId): void;
}

export interface DocStore {
  get(id: ShapeId): Shape | undefined;
  /** Every shape, after invariant repair (no parent cycles, no dangling parents). */
  all(): Iterable<Shape>;
  /** Applies mutations atomically: subscribers see one batch, undo sees one step. */
  transact(fn: (tx: Tx) => void, origin?: Origin): void;
  subscribe(listener: (changes: ShapeChange[], origin: Origin) => void): () => void;
  undo(): void;
  redo(): void;
}
