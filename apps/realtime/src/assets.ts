import { createHash } from "node:crypto";

/**
 * Images on boards. The board document holds only an image's id, the
 * SHA-256 of its bytes; the bytes are kept here, per board, and served over
 * HTTP. See docs/decisions/0008-images-and-reactions.md.
 */

/** The image types accepted, by the bytes each starts with. SVG is not one: it can carry script. */
export const IMAGE_TYPES = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  // "RIFF", four bytes of length, "WEBP".
  "image/webp": [[0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50]],
} as const satisfies Record<string, readonly (readonly number[])[]>;

export type ImageType = keyof typeof IMAGE_TYPES;

/** The type `data` really is, going by its first bytes, or null when it isn't one we take. */
export function sniffImageType(data: Uint8Array): ImageType | null {
  for (const [type, signatures] of Object.entries(IMAGE_TYPES)) {
    for (const signature of signatures) {
      if (signature.every((byte, i) => byte === -1 || data[i] === byte)) return type as ImageType;
    }
  }
  return null;
}

export const assetId = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

export interface StoredAsset {
  readonly type: ImageType;
  readonly data: Uint8Array;
}

/** What `put` did: kept it, already had it, or refused it because the board's images are over `maxBoardBytes`. */
export type PutResult = "stored" | "exists" | "full";

export interface AssetStorage {
  /** Keeps `data` as image `id` of the board, unless the board's images would then pass `maxBoardBytes`. */
  put(boardId: string, id: string, asset: StoredAsset, maxBoardBytes: number): Promise<PutResult>;
  get(boardId: string, id: string): Promise<StoredAsset | null>;
}

/** Images in memory, for development and tests: lost on restart. */
export class MemoryAssets implements AssetStorage {
  private readonly boards = new Map<string, Map<string, StoredAsset>>();

  async put(
    boardId: string,
    id: string,
    asset: StoredAsset,
    maxBoardBytes: number,
  ): Promise<PutResult> {
    let board = this.boards.get(boardId);
    if (board?.has(id)) return "exists";
    let total = 0;
    for (const stored of board?.values() ?? []) total += stored.data.byteLength;
    if (total + asset.data.byteLength > maxBoardBytes) return "full";
    if (!board) {
      board = new Map();
      this.boards.set(boardId, board);
    }
    board.set(id, asset);
    return "stored";
  }

  async get(boardId: string, id: string): Promise<StoredAsset | null> {
    return this.boards.get(boardId)?.get(id) ?? null;
  }
}
