import type { Shape, ShapeId, ShapePatch } from "./shape";

/** Who made a change: this user (including their undo and redo), or a collaborator. */
export type Origin = "local" | "remote";

/** Replace `deleteCount` characters at `index` with `insert`. */
export interface TextEdit {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

export type ShapeChange =
  | { readonly kind: "added"; readonly shape: Shape }
  | {
      readonly kind: "updated";
      readonly shape: Shape;
      readonly previous: Shape;
      /**
       * How the text changed, when it did and the store can tell: edits in
       * order, each at a position in the text as the ones before it left it.
       * An editor uses them to keep its cursor on the same characters, which
       * comparing old and new text can only guess at ("aa" to "aaa").
       */
      readonly textEdits?: readonly TextEdit[];
    }
  | { readonly kind: "removed"; readonly previous: Shape };

/** Mutations allowed inside `DocStore.transact`. */
export interface Tx {
  add(shape: Shape): void;
  /** Writes only the fields whose value differs, so unchanged fields cost nothing. */
  update(id: ShapeId, patch: ShapePatch): void;
  /**
   * Replaces `deleteCount` characters of the shape's text at `index` with
   * `insert`, as an edit to the characters rather than a new value: someone
   * typing elsewhere in the same text keeps their characters. Out-of-range
   * positions are clamped.
   */
  editText(id: ShapeId, index: number, deleteCount: number, insert: string): void;
  remove(id: ShapeId): void;
}

/**
 * The only way the engine reads or changes the board. Implemented on Yjs by
 * `@niro/doc/yjs`; the engine never imports a sync library.
 */
export interface DocStore {
  /**
   * True when this user can't edit the board: they have a view link, the
   * board is full, or it was written by a newer version of Niro (shown but
   * not edited, so this version can't damage data it doesn't understand).
   * `transact` does nothing.
   */
  readonly readOnly: boolean;
  get(id: ShapeId): Shape | undefined;
  /** Every drawable shape, in no particular order. */
  all(): Iterable<Shape>;
  /**
   * Applies local mutations atomically: subscribers see one batch and
   * collaborators receive one update.
   */
  transact(fn: (tx: Tx) => void): void;
  /**
   * Called after every transaction, local or remote, that changed a shape,
   * and with no changes when `readOnly` changes.
   */
  subscribe(listener: (changes: readonly ShapeChange[], origin: Origin) => void): () => void;
  /**
   * Ends the current undo step. Changes made within a short time of each
   * other merge into one step (a drag is one step), so call this at the
   * start of every gesture or command.
   */
  checkpoint(): void;
  /** Reverts this user's last step. Collaborators' changes are never undone. */
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}
