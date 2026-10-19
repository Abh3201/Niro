import { type Camera, centerOn, nextZoomStep, zoomAt } from "./camera";
import type { Viewport } from "./geometry";
import { drawGrid } from "./grid";
import { InputController } from "./input";
import { Layer } from "./layers";
import { drawScene } from "./scene";

export interface EngineState {
  readonly camera: Camera;
  readonly viewport: Viewport;
}

export interface EngineOptions {
  /** Starting camera. By default the world origin is centered at 100%. */
  camera?: Camera;
}

export interface Engine {
  /** Current state. The object is replaced (never mutated) on every change. */
  getState(): EngineState;
  /** Calls `listener` after every state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  setCamera(camera: Camera): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  /** Marks everything as changed; it is redrawn once, on the next animation frame. */
  invalidate(): void;
  /** Stops rendering and removes everything the engine added to the page. */
  destroy(): void;
}

interface Theme {
  gridDot: string;
}

const DEFAULT_THEME: Theme = { gridDot: "#c4c6cf" };

/**
 * Mounts the engine into `container`, which it fills completely.
 *
 * The engine owns three stacked canvases: background (grid), shapes, and overlay
 * (selection, cursors). Callers, React or anything else, only hand it a container
 * and read its state through `getState` and `subscribe`.
 */
export function createEngine(container: HTMLElement, options: EngineOptions = {}): Engine {
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  container.style.touchAction = "none";
  container.style.userSelect = "none";
  container.style.overflow = "hidden";

  const background = new Layer(container, "background");
  const shapes = new Layer(container, "shapes");
  const overlay = new Layer(container, "overlay");
  const layers = [background, shapes, overlay];

  let state: EngineState = {
    camera: options.camera ?? { x: 0, y: 0, zoom: 1 },
    viewport: { width: 0, height: 0 },
  };
  let cameraPlaced = options.camera !== undefined;
  let pixelRatio = window.devicePixelRatio || 1;
  let theme = readTheme(container);
  let frame: number | null = null;
  const listeners = new Set<() => void>();

  const setState = (next: EngineState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const schedule = () => {
    frame ??= requestAnimationFrame(render);
  };

  const markAllDirty = () => {
    for (const layer of layers) layer.dirty = true;
    schedule();
  };

  const setCamera = (camera: Camera) => {
    const current = state.camera;
    if (camera.x === current.x && camera.y === current.y && camera.zoom === current.zoom) return;
    setState({ ...state, camera });
    markAllDirty();
  };

  function render() {
    frame = null;
    const { camera, viewport } = state;
    const pr = pixelRatio;

    if (background.dirty) {
      background.ctx.setTransform(pr, 0, 0, pr, 0, 0);
      drawGrid(background.ctx, camera, viewport, theme.gridDot);
      background.dirty = false;
    }

    if (shapes.dirty) {
      const ctx = shapes.ctx;
      ctx.setTransform(pr, 0, 0, pr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      // World -> device pixels: scale by zoom and pixel ratio, shift by the camera.
      const scale = pr * camera.zoom;
      ctx.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);
      drawScene(ctx);
      shapes.dirty = false;
    }

    if (overlay.dirty) {
      overlay.ctx.setTransform(pr, 0, 0, pr, 0, 0);
      overlay.ctx.clearRect(0, 0, viewport.width, viewport.height);
      overlay.dirty = false;
    }
  }

  const resize = () => {
    const { width, height } = container.getBoundingClientRect();
    pixelRatio = window.devicePixelRatio || 1;
    for (const layer of layers) layer.resize(width, height, pixelRatio);

    const viewport = { width, height };
    let camera = state.camera;
    if (!cameraPlaced && width > 0 && height > 0) {
      camera = centerOn({ x: 0, y: 0 }, viewport);
      cameraPlaced = true;
    }
    setState({ camera, viewport });
    schedule();
  };

  const viewportCenter = () => ({ x: state.viewport.width / 2, y: state.viewport.height / 2 });

  const zoomStep = (direction: 1 | -1) => {
    const camera = state.camera;
    setCamera(zoomAt(camera, viewportCenter(), nextZoomStep(camera.zoom, direction)));
  };

  const resetZoom = () => setCamera(zoomAt(state.camera, viewportCenter(), 1));

  // ResizeObserver doesn't fire when the window moves to a screen with a different
  // pixel ratio, so watch the ratio itself too.
  let pixelRatioQuery: MediaQueryList | null = null;
  const onPixelRatioChange = () => {
    resize();
    watchPixelRatio();
  };
  const watchPixelRatio = () => {
    pixelRatioQuery?.removeEventListener("change", onPixelRatioChange);
    pixelRatioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    pixelRatioQuery.addEventListener("change", onPixelRatioChange);
  };

  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onColorSchemeChange = () => {
    theme = readTheme(container);
    markAllDirty();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  watchPixelRatio();
  colorScheme.addEventListener("change", onColorSchemeChange);
  resize();

  const input = new InputController(
    {
      container,
      getCamera: () => state.camera,
      setCamera,
      getViewport: () => state.viewport,
      zoomStep,
      resetZoom,
    },
    { primaryDragPans: true },
  );

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setCamera,
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
    resetZoom,
    invalidate: markAllDirty,
    destroy() {
      input.destroy();
      observer.disconnect();
      pixelRatioQuery?.removeEventListener("change", onPixelRatioChange);
      colorScheme.removeEventListener("change", onColorSchemeChange);
      if (frame !== null) cancelAnimationFrame(frame);
      for (const layer of layers) layer.destroy();
      listeners.clear();
    },
  };
}

function readTheme(container: HTMLElement): Theme {
  const style = getComputedStyle(container);
  return { gridDot: style.getPropertyValue("--grid-dot").trim() || DEFAULT_THEME.gridDot };
}
