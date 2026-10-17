import type { Role } from "@niro/sync";

/** The keys this browser was given for one board. */
export interface Keys {
  readonly edit?: string;
  readonly view?: string;
}

/** `e.` or `v.` and 22 base64url characters (see `shareKey` in `@niro/sync/auth`). */
const KEY = /^[ev]\.[A-Za-z0-9_-]{22}$/;

const storageName = (boardId: string) => `niro:keys:${boardId}`;

/**
 * The role a key claims, from its prefix. Only the server can tell whether
 * the key is genuine; this just lets the page start in the right mode.
 */
export function roleOf(key: string): Role {
  return key.startsWith("e.") ? "edit" : "view";
}

export function readKeys(boardId: string): Keys {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageName(boardId)) ?? "{}");
    if (typeof stored !== "object" || stored === null) return {};
    const { edit, view } = stored as Record<string, unknown>;
    return {
      ...(typeof edit === "string" && KEY.test(edit) && { edit }),
      ...(typeof view === "string" && KEY.test(view) && { view }),
    };
  } catch {
    return {};
  }
}

/** Remembers a key, so opening the board again without one in the link still works. */
export function rememberKey(boardId: string, key: string): void {
  if (!KEY.test(key)) return;
  try {
    const keys = { ...readKeys(boardId), [roleOf(key)]: key };
    localStorage.setItem(storageName(boardId), JSON.stringify(keys));
  } catch {
    // Storage is off or full: the link still works, it's just not remembered.
  }
}

/**
 * The key to open the board with: the one in the link (`#k=…`), or else the
 * best one this browser was given before, which then goes back in the
 * address bar so copying it shares the same access.
 */
export function currentKey(boardId: string): string | null {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("k");
  if (fromLink && KEY.test(fromLink)) {
    rememberKey(boardId, fromLink);
    return fromLink;
  }
  const { edit, view } = readKeys(boardId);
  const key = edit ?? view ?? null;
  if (key) window.history.replaceState(window.history.state, "", `#k=${key}`);
  return key;
}

export function shareLink(boardId: string, key: string): string {
  return `${window.location.origin}/b/${boardId}#k=${key}`;
}
