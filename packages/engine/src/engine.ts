import { backingStoreSize } from "./canvas";
import { drawScene, type Viewport } from "./render";

export interface Engine {
  /** Marks the scene as changed. It is redrawn once, on the next animation frame. */
  invalidate(): void;
  /** Stops rendering and removes everything the engine added to the page. */
  destroy(): void;
}

/**
 * Mounts the engine into `container`, which it fills completely.
 *
 * The engine owns its canvases; callers (React or anything else) only hand it a
 * container element. P1 adds the camera and input, and splits rendering into
 * background, shapes and overlay layers.
 */
export function createEngine(container: HTMLElement): Engine {
  const canvas = document.createElement("canvas");
  canvas.dataset.layer = "shapes";
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.append(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    throw new Error("Canvas 2D is not available in this browser.");
  }

  let viewport: Viewport = { width: 0, height: 0 };
  let pixelRatio = 1;
  let frame: number | null = null;

  const render = () => {
    frame = null;
    // Draw in CSS pixels; the transform maps them onto device pixels.
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawScene(ctx, viewport);
  };

  const invalidate = () => {
    frame ??= requestAnimationFrame(render);
  };

  const resize = () => {
    const { width, height } = container.getBoundingClientRect();
    pixelRatio = window.devicePixelRatio || 1;
    viewport = { width, height };

    const size = backingStoreSize(width, height, pixelRatio);
    if (canvas.width !== size.width || canvas.height !== size.height) {
      // Assigning the size clears the canvas and resets its context state.
      canvas.width = size.width;
      canvas.height = size.height;
    }
    invalidate();
  };

  // Moving the window to a screen with a different pixel ratio doesn't resize the
  // container; P1 listens for that with matchMedia.
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  return {
    invalidate,
    destroy() {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      canvas.remove();
    },
  };
}
