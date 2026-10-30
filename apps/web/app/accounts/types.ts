/** What pages know about accounts. Safe for the browser: no secrets. */

/** The signed-in person, as pages show them. */
export interface Viewer {
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}

/** A board's account side, for the board page. Null when the server has no accounts. */
export interface BoardAccount {
  /** Who's signed in, or null. */
  readonly viewer: Viewer | null;
  /** The board's name: "Untitled board" until its owner names it. */
  readonly title: string;
  /** True when the viewer owns the board: they can rename it. */
  readonly owned: boolean;
  /** True when nobody owns the board: a signed-in editor can make it theirs. */
  readonly ownerless: boolean;
}
