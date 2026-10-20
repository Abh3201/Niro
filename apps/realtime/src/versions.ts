/**
 * Saved versions of a board: its whole state at a moment, kept by the
 * realtime server so a board can be looked at, and put back, as it was. See
 * docs/decisions/0011-version-history.md.
 *
 * A version is a full Yjs state, not a Yjs snapshot: a snapshot needs the
 * document to keep every deleted item (`gc: false`), which makes every board
 * grow forever. Full states cost disk, only here and only for what's kept.
 */

export interface VersionInfo {
  /** Digits only: safe in a URL. */
  readonly id: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  /** What the person who saved it called it; null for those the server saves by itself. */
  readonly label: string | null;
  /** True for a version the server saved on its own (an hour of editing, say). */
  readonly auto: boolean;
  /** Size of the stored state. */
  readonly bytes: number;
}

export interface NewVersion {
  readonly label: string | null;
  readonly auto: boolean;
  readonly state: Uint8Array;
}

export interface VersionLimits {
  /** Versions kept per board; the oldest go first, those saved by the server before those saved by people. */
  readonly count: number;
  /** All of one board's versions together. */
  readonly bytes: number;
}

export interface VersionStorage {
  /** The board's versions, newest first, without their states. */
  listVersions(boardId: string): Promise<VersionInfo[]>;
  /**
   * Keeps a version, then drops the oldest until the board is within
   * `limits`. Returns null (and keeps nothing) when the state alone is over
   * the byte limit.
   */
  saveVersion(
    boardId: string,
    version: NewVersion,
    limits: VersionLimits,
  ): Promise<VersionInfo | null>;
  loadVersion(boardId: string, id: string): Promise<Uint8Array | null>;
}

/**
 * Which versions to drop so `versions` (oldest first, `keep` among them)
 * fit `limits`: the oldest saved by the server first, then the oldest saved
 * by people. `keep` itself is never dropped.
 */
export function versionsToDrop(
  versions: readonly VersionInfo[],
  keep: string,
  limits: VersionLimits,
): string[] {
  const drop: string[] = [];
  let count = versions.length;
  let bytes = versions.reduce((sum, v) => sum + v.bytes, 0);
  const order = [
    ...versions.filter((v) => v.auto && v.id !== keep),
    ...versions.filter((v) => !v.auto && v.id !== keep),
  ];
  for (const version of order) {
    if (count <= limits.count && bytes <= limits.bytes) break;
    drop.push(version.id);
    count--;
    bytes -= version.bytes;
  }
  return drop;
}

/** Versions in memory, for development and tests: lost on restart. */
export class MemoryVersions implements VersionStorage {
  private readonly boards = new Map<string, { info: VersionInfo; state: Uint8Array }[]>();
  private next = 1;

  constructor(private readonly now: () => number = Date.now) {}

  async listVersions(boardId: string): Promise<VersionInfo[]> {
    return (this.boards.get(boardId) ?? []).map((v) => v.info).reverse();
  }

  async saveVersion(boardId: string, version: NewVersion, limits: VersionLimits) {
    if (version.state.byteLength > limits.bytes) return null;
    const info: VersionInfo = {
      id: String(this.next++),
      createdAt: this.now(),
      label: version.label,
      auto: version.auto,
      bytes: version.state.byteLength,
    };
    const all = [...(this.boards.get(boardId) ?? []), { info, state: version.state }];
    const drop = new Set(
      versionsToDrop(
        all.map((v) => v.info),
        info.id,
        limits,
      ),
    );
    this.boards.set(
      boardId,
      all.filter((v) => !drop.has(v.info.id)),
    );
    return info;
  }

  async loadVersion(boardId: string, id: string): Promise<Uint8Array | null> {
    return this.boards.get(boardId)?.find((v) => v.info.id === id)?.state ?? null;
  }
}
