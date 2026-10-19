import type { Shape, ShapeId, ShapePatch } from "./shape";

/** Who made a change: this user (including their undo and redo), or a collaborator. */
export type Origin = "local" | "remote";

export type ShapeChange =
  | { readonly kind: "added"; readonly shape: Shape }
  | { readonly kind: "updated"; readonly shape: Shape; readonly previous: Shape }
  | { readonly kind: "removed"; readonly previous: Shape };

/** Mutations allowed inside `DocStore.transact`. */
export interface Tx {
  add(shape: Shape): void;
  /** Writes only the fields whose value differs, so unchanged fields cost nothing. */
  update(id: ShapeId, patch: ShapePatch): void;
  remove(id: ShapeId): void;
}

/**
 * The only way the engine reads or changes the board. Implemented on Yjs by
 * `@niro/doc/yjs`; the engine never imports a sync library.
 */
export interface DocStore {
  /**
   * True when the board was written by a newer version of Niro. It is shown
   * but can't be edited, so this version can't damage data it doesn't
   * understand. `transact` does nothing.
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
  /** Called after every transaction, local or remote, that changed a shape. */
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
