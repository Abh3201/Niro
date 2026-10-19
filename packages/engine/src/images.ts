/**
 * Pictures for image shapes. The engine doesn't know where files live: the
 * app passes a loader, and this keeps what it loaded, one per file, however
 * many shapes show it.
 */

/** Loads an image's file by its id; rejects when it can't. */
export type ImageLoader = (asset: string) => Promise<CanvasImageSource>;

/** After a failed load, how long before trying again, in ms. */
const RETRY_MS = 10_000;

type Entry =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly image: CanvasImageSource }
  | { readonly state: "failed" };

export class ImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;

  /** `changed` is called when a picture arrives, or when a failed one may be tried again. */
  constructor(
    private readonly load: ImageLoader | undefined,
    private readonly changed: () => void,
  ) {}

  /** The picture for `asset`, or undefined while it loads (it starts loading now). */
  get(asset: string | undefined): CanvasImageSource | undefined {
    if (!asset || !this.load) return undefined;
    const entry = this.entries.get(asset);
    if (entry) return entry.state === "ready" ? entry.image : undefined;
    this.entries.set(asset, { state: "loading" });
    this.load(asset).then(
      (image) => {
        if (this.destroyed) return close(image);
        this.entries.set(asset, { state: "ready", image });
        this.changed();
      },
      () => {
        if (this.destroyed) return;
        this.entries.set(asset, { state: "failed" });
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.entries.delete(asset);
          this.changed();
        }, RETRY_MS);
        this.timers.add(timer);
      },
    );
    return undefined;
  }

  destroy(): void {
    this.destroyed = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const entry of this.entries.values()) if (entry.state === "ready") close(entry.image);
    this.entries.clear();
  }
}

/** Frees an ImageBitmap's memory now rather than at garbage collection. */
function close(image: CanvasImageSource): void {
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
}
