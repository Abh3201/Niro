import { createYDocStore, type YDocStore } from "@niro/doc/yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

/** How long to wait for IndexedDB before showing the board without saved content. */
const LOAD_TIMEOUT_MS = 3000;

export interface LocalBoard {
  readonly store: YDocStore;
  /** False when IndexedDB isn't available or didn't answer: edits may not survive a reload. */
  readonly saved: boolean;
  destroy(): void;
}

/**
 * Opens a board stored in this browser. P3a adds the server connection next
 * to IndexedDB; the store is the same either way.
 *
 * The store is created only after IndexedDB has loaded, because creating it
 * migrates the document (see `createYDocStore`).
 */
export async function openLocalBoard(boardId: string): Promise<LocalBoard> {
  const doc = new Y.Doc();
  let persistence: IndexeddbPersistence | null = null;
  let saved = false;
  try {
    persistence = new IndexeddbPersistence(`niro:board:${boardId}`, doc);
    saved = await Promise.race([
      persistence.whenSynced.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), LOAD_TIMEOUT_MS)),
    ]);
  } catch {
    saved = false;
  }

  const store = createYDocStore(doc);
  return {
    store,
    saved,
    destroy() {
      store.destroy();
      void persistence?.destroy();
      doc.destroy();
    },
  };
}
