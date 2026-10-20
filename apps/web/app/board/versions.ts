/**
 * A board's saved versions, kept by the realtime server (see
 * docs/decisions/0011-version-history.md): listing them, saving one, and
 * fetching one's state to look at or restore.
 */

export interface VersionInfo {
  readonly id: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  /** What the person who saved it called it; null for those the server saved by itself. */
  readonly label: string | null;
  readonly auto: boolean;
  readonly bytes: number;
}

export interface Versions {
  /** Newest first. */
  list(): Promise<VersionInfo[]>;
  /** Saves the board as it is now. Rejects with a `VersionError` that says why when it can't. */
  save(label: string | null): Promise<VersionInfo>;
  /** One version's whole state, as a Yjs update. */
  load(id: string): Promise<Uint8Array>;
}

/** Something to tell the person: the server said no. */
export class VersionError extends Error {}

interface VersionsOptions {
  boardId: string;
  /** The realtime server's `ws://` or `wss://` base URL; versions are on the same host over HTTP. */
  realtimeUrl: string;
  /** A token for the board, from the web app. */
  token(): Promise<string>;
}

export function createVersions({ boardId, realtimeUrl, token }: VersionsOptions): Versions {
  const base = `${realtimeUrl.replace(/^ws/, "http")}/versions/${encodeURIComponent(boardId)}`;
  const request = async (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await token()}` },
    });

  return {
    async list() {
      const response = await request("");
      if (!response.ok) throw new VersionError("The saved versions couldn't be loaded.");
      return ((await response.json()) as { versions: VersionInfo[] }).versions;
    },
    async save(label) {
      const response = await request("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!response.ok) throw new VersionError(saveRefusal(response.status));
      return (await response.json()) as VersionInfo;
    },
    async load(id) {
      const response = await request(`/${encodeURIComponent(id)}`);
      if (!response.ok) throw new VersionError("That version couldn't be loaded.");
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function saveRefusal(status: number): string {
  if (status === 429) return "Saved a moment ago. Wait a couple of seconds and try again.";
  if (status === 413) return "This board is too big to keep versions of.";
  if (status === 401 || status === 403) return "This link can't save versions.";
  if (status === 409) return "The board isn't open on the server yet. Try again in a moment.";
  return "The version couldn't be saved. Check your connection and try again.";
}
