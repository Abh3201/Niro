import { backingStoreSize } from "./canvas";

/**
 * One full-size canvas in the engine's stack. Each layer redraws only when it is
 * marked dirty, so moving a cursor on the overlay never repaints the shapes.
 */
export class Layer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  dirty = true;

  constructor(container: HTMLElement, name: string) {
    this.canvas = document.createElement("canvas");
    this.canvas.dataset.layer = name;
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
    });
    container.append(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      this.canvas.remove();
      throw new Error("Canvas 2D is not available in this browser.");
    }
    this.ctx = ctx;
  }

  /** Matches the backing store to the CSS size and pixel ratio. */
  resize(width: number, height: number, pixelRatio: number): void {
    const size = backingStoreSize(width, height, pixelRatio);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      // Assigning the size clears the canvas and resets its context state.
      this.canvas.width = size.width;
      this.canvas.height = size.height;
    }
    this.dirty = true;
  }

  destroy(): void {
    this.canvas.remove();
  }
}
