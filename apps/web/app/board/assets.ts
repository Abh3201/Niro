/**
 * A board's images, kept by the realtime server (see
 * docs/decisions/0008-images-and-reactions.md): uploading a picture, after
 * shrinking it if it's big, and loading one to draw.
 */

/** Types the server takes. */
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Longest side an image is stored at, in pixels: plenty for a board, and 16 MB once decoded. */
export const MAX_IMAGE_SIDE = 2048;
/** Files up to this size are uploaded as they are when they're no bigger than `MAX_IMAGE_SIDE`. */
const KEEP_AS_IS_BYTES = 1024 * 1024;
/** The server's default limit, `NIRO_MAX_IMAGE_MB`. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface UploadedImage {
  /** The id to put on the image shape. */
  readonly asset: string;
  readonly width: number;
  readonly height: number;
}

export interface Assets {
  /** Uploads a picture; rejects with an `ImageError` that says why when it can't. */
  upload(file: Blob): Promise<UploadedImage>;
  /** Fetches and decodes an image to draw. */
  load(asset: string): Promise<ImageBitmap>;
}

/** Something to tell the person: the picture isn't one we can take, or the server said no. */
export class ImageError extends Error {}

interface AssetsOptions {
  boardId: string;
  /** The realtime server's `ws://` or `wss://` base URL; images are on the same host over HTTP. */
  realtimeUrl: string;
  /** A token for the board, from the web app. */
  token(): Promise<string>;
}

export function createAssets({ boardId, realtimeUrl, token }: AssetsOptions): Assets {
  const base = `${realtimeUrl.replace(/^ws/, "http")}/assets/${encodeURIComponent(boardId)}`;
  const request = async (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await token()}` },
    });

  return {
    async upload(file) {
      const prepared = await prepareImage(file);
      const response = await request("", {
        method: "POST",
        headers: { "content-type": prepared.blob.type },
        body: prepared.blob,
      });
      if (!response.ok) throw new ImageError(uploadRefusal(response.status));
      const { id } = (await response.json()) as { id: string };
      return { asset: id, width: prepared.width, height: prepared.height };
    },
    async load(asset) {
      const response = await request(`/${asset}`);
      if (!response.ok) throw new Error(`Image ${asset} failed with ${response.status}`);
      return createImageBitmap(await response.blob());
    },
  };
}

function uploadRefusal(status: number): string {
  if (status === 413) return "The image is too big, or this board has no room for more images.";
  if (status === 415) return "That file isn't a PNG, JPEG, GIF or WebP image.";
  if (status === 401 || status === 403) return "This link can't add images to the board.";
  return "The image couldn't be uploaded. Check your connection and try again.";
}

/**
 * The file to upload and its size in pixels. Small files are sent as they
 * are; big ones are drawn smaller and re-encoded (WebP keeps transparency;
 * where a browser can't write WebP, PNG, or JPEG if PNG is too big).
 */
async function prepareImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  if (!file.type.startsWith("image/")) throw new ImageError("That file isn't an image.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageError("That image couldn't be read. Try a PNG, JPEG, GIF or WebP file.");
  }
  try {
    const { width, height } = bitmap;
    if (
      ACCEPTED.has(file.type) &&
      file.size <= KEEP_AS_IS_BYTES &&
      Math.max(width, height) <= MAX_IMAGE_SIDE
    )
      return { blob: file, width, height };
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageError("This browser can't prepare images.");
    ctx.drawImage(bitmap, 0, 0, w, h);
    let blob = await encode(canvas, "image/webp", 0.9);
    if (blob?.type !== "image/webp") blob = await encode(canvas, "image/png");
    if (!blob || blob.size > MAX_UPLOAD_BYTES) blob = await encode(canvas, "image/jpeg", 0.85);
    if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new ImageError("The image is too big.");
    return { blob, width: w, height: h };
  } finally {
    bitmap.close();
  }
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** The first image among dropped or pasted files, if any. */
export function firstImage(files: FileList | null | undefined): File | null {
  for (const file of files ?? []) if (file.type.startsWith("image/")) return file;
  return null;
}
