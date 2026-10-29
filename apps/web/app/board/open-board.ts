import { type CommentStore, createCommentStore } from "@niro/doc/comments";
import { createYDocStore, type YDocStore } from "@niro/doc/yjs";
import {
  AccessDenied,
  fromWebSocket,
  PROTOCOL_VERSION,
  type Role,
  type Socket,
  SyncClient,
  type SyncStatus,
} from "@niro/sync";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { readKeys, rememberKey, roleOf } from "./access";
import { type Assets, createAssets } from "./assets";
import { loadIdentity, Presence } from "./presence";
import { createVersions, type Versions } from "./versions";

/** How long to wait for IndexedDB before showing the board without saved content. */
const LOAD_TIMEOUT_MS = 3000;
/** How long a browser with nothing saved waits for the server's copy before showing the board. */
const SYNC_TIMEOUT_MS = 3000;
/** Reuse a token this long; it lasts 60 s, and an image request may be slow to start. */
const TOKEN_REUSE_MS = 40_000;

export interface OpenBoard {
  readonly store: YDocStore;
  /** The board's images: uploading and loading them. */
  readonly assets: Assets;
  /** Comments pinned on the board. Writes are ignored while `store` is read-only. */
  readonly comments: CommentStore;
  /** The board's saved versions. */
  readonly versions: Versions;
  readonly presence: Presence;
  /** The key the board was opened with. */
  readonly key: string | null;
  /**
   * What the key grants. Without a key, or with one the server refused,
   * it's "view", of whatever this browser has saved.
   */
  readonly role: Role;
  /** False when IndexedDB isn't available or didn't answer: edits may not survive a reload. */
  readonly saved: boolean;
  /** The connection to the realtime server, for `useSyncExternalStore`. */
  readonly status: {
    get(): SyncStatus;
    subscribe(listener: () => void): () => void;
  };
  /**
   * Why the server takes no more changes to this board ("full"), or null.
   * The store is read-only meanwhile. For `useSyncExternalStore`.
   */
  readonly refusal: {
    get(): string | null;
    subscribe(listener: () => void): () => void;
  };
  /** The view key, for editors to share, once known. For `useSyncExternalStore`. */
  readonly viewKey: {
    get(): string | null;
    subscribe(listener: () => void): () => void;
  };
  destroy(): void;
}

export interface OpenBoardOptions {
  boardId: string;
  /** The key from the share link, or null when there is none. */
  key: string | null;
  /** The realtime server's base URL, `ws://` or `wss://`. */
  realtimeUrl: string;
  /**
   * The signed-in person's name, when there is one. Their account may give
   * them access without a key, or more than the key gives.
   */
  accountName?: string | null;
}

interface TokenResponse {
  token: string;
  role: Role;
  /** The key for `role`: the link's, or the one the account gives. */
  key?: string;
  viewKey?: string;
}

/**
 * Opens a board: what this browser saved (IndexedDB), then live with
 * everyone else through the realtime server. Edits made offline are kept
 * and sent when the connection comes back.
 */
export async function openBoard(options: OpenBoardOptions): Promise<OpenBoard> {
  const { boardId, realtimeUrl, accountName = null } = options;
  let key = options.key;
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

  const awareness = new Awareness(doc);
  // Before connecting, so the first presence others see has a name.
  const presence = new Presence(awareness, loadIdentity(accountName));
  let viewKey = key && roleOf(key) === "edit" ? (readKeys(boardId).view ?? null) : null;
  const viewKeyListeners = new Set<() => void>();

  const requestGrant = async (): Promise<TokenResponse> => {
    // Without a key, only a signed-in account can give access.
    if (!key && accountName === null) throw new AccessDenied();
    const response = await fetch("/api/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId, key }),
    });
    // 410: the board was deleted.
    if (response.status === 403 || response.status === 410) throw new AccessDenied();
    if (!response.ok) throw new Error(`Token request failed with ${response.status}`);
    const grant = (await response.json()) as TokenResponse;
    if (grant.key && grant.key !== key && (!key || roleOf(key) === "view")) {
      // The account gives access the link didn't: use, remember and show that key.
      key = grant.key;
      rememberKey(boardId, key);
      window.history.replaceState(window.history.state, "", `#k=${key}`);
    }
    if (grant.viewKey && grant.viewKey !== viewKey) {
      viewKey = grant.viewKey;
      rememberKey(boardId, viewKey);
      for (const listener of viewKeyListeners) listener();
    }
    return grant;
  };

  // Image and version requests share one token until it's close to running out.
  let reusable: { token: Promise<string>; until: number } | null = null;
  const imageToken = (): Promise<string> => {
    if (reusable && Date.now() < reusable.until) return reusable.token;
    const token = requestGrant().then((grant) => grant.token);
    reusable = { token, until: Date.now() + TOKEN_REUSE_MS };
    token.catch(() => {
      reusable = null;
    });
    return token;
  };

  // Signed in, ask first: the account may give access (or more of it) that
  // the link doesn't, and the board should open in that mode. The answer's
  // token opens the first connection.
  let first: Promise<TokenResponse> | null = null;
  if (accountName !== null) {
    first = requestGrant();
    await first.catch(() => {});
  }

  const connect = async (): Promise<Socket> => {
    const pending = first;
    first = null;
    const grant = await (pending ?? requestGrant());
    const query = new URLSearchParams({
      v: String(PROTOCOL_VERSION),
      board: boardId,
      token: grant.token,
    });
    return fromWebSocket(new WebSocket(`${realtimeUrl}/ws?${query}`));
  };
  const client = new SyncClient({ doc, awareness, connect });

  // A browser seeing this board for the first time waits for the server's
  // copy, so the board opens with its content (and migrations, when there
  // are any, run on the real document rather than on an empty one).
  if (doc.store.clients.size === 0) await settled(client, SYNC_TIMEOUT_MS);

  // A key the server already turned down grants nothing: show what's here, read-only.
  const role = key && client.status !== "denied" ? roleOf(key) : "view";
  const store = createYDocStore(doc, { readOnly: role === "view" });
  // A refusal can also come after the board opened (a returning visitor
  // whose saved copy let it open before the server answered): then edits
  // would stay in this browser only, so stop them.
  const comments = createCommentStore(doc, { readOnly: role === "view" });
  const followServer = () => {
    const refused = client.readOnly !== null || client.status === "denied";
    store.setReadOnly(refused);
    comments.setReadOnly(role === "view" || refused);
  };
  followServer();
  client.subscribe(followServer);
  // The browser knows before the backoff timer that the network is back.
  const onOnline = () => client.reconnectNow();
  window.addEventListener("online", onOnline);

  return {
    store,
    comments,
    assets: createAssets({ boardId, realtimeUrl, token: imageToken }),
    versions: createVersions({ boardId, realtimeUrl, token: imageToken }),
    presence,
    key,
    role,
    saved,
    status: {
      get: () => client.status,
      subscribe: (listener) => client.subscribe(listener),
    },
    refusal: {
      get: () => client.readOnly,
      subscribe: (listener) => client.subscribe(listener),
    },
    viewKey: {
      get: () => viewKey,
      subscribe(listener) {
        viewKeyListeners.add(listener);
        return () => viewKeyListeners.delete(listener);
      },
    },
    destroy() {
      viewKeyListeners.clear();
      window.removeEventListener("online", onOnline);
      store.destroy();
      comments.destroy();
      presence.destroy();
      client.destroy();
      awareness.destroy();
      void persistence?.destroy();
      doc.destroy();
    },
  };
}

/** Resolves once the client is caught up or refused, or after `timeoutMs`. */
function settled(client: SyncClient, timeoutMs: number): Promise<void> {
  const done = (status: SyncStatus) => status === "online" || status === "denied";
  if (done(client.status)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = client.subscribe((status) => {
      if (done(status)) finish();
    });
  });
}
