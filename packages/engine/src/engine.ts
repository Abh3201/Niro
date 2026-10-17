import {
  type ColorName,
  type DocStore,
  indexesAbove,
  newShapeId,
  reorderStep,
  reorderToEnd,
  type Shape,
  type ShapeId,
} from "@niro/doc";
import {
  type Camera,
  centerOn,
  nextZoomStep,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "./camera";
import type { Point, Viewport } from "./geometry";
import { drawGrid } from "./grid";
import { InputController } from "./input";
import { type EditorHost, Interaction, type ToolName } from "./interaction";
import { Layer } from "./layers";
import { type RemotePeer, SmoothedCursors } from "./presence";
import { DARK_PALETTE, drawShape, LIGHT_PALETTE, type Palette } from "./render";
import { Scene } from "./scene";
import { HANDLE_SIZE, placeHandles, type SelectionFrame, selectionFrame } from "./selection";
import { shapeCenter, shapeOutline } from "./shapes";
import { translate } from "./transform";

export type { ToolName } from "./interaction";

export interface EngineState {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly tool: ToolName;
  /** Selected shape ids. Local to this user: selection never goes into the document. */
  readonly selection: readonly ShapeId[];
  /** The color every selected shape shares, or null when mixed or nothing is selected. */
  readonly selectionColor: ColorName | null;
  readonly shapeCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The board was saved by a newer version of Niro and can't be edited here. */
  readonly readOnly: boolean;
}

export interface EngineOptions {
  /** The board document. The engine reads and writes shapes only through it. */
  doc: DocStore;
  /** Starting camera. By default the world origin is centered at 100%. */
  camera?: Camera;
  /**
   * Called with the world position under the mouse or pen as it moves (or
   * as the board moves under it), and with null when it leaves the board.
   * For showing this user's cursor to others.
   */
  onPointerMove?: (world: Point | null) => void;
}

export type ReorderDirection = "forward" | "backward" | "front" | "back";

export interface Engine {
  /** Current state. The object is replaced (never mutated) on every change. */
  getState(): EngineState;
  /** Calls `listener` after every state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  setCamera(camera: Camera): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  setTool(tool: ToolName): void;
  select(ids: readonly ShapeId[]): void;
  selectAll(): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  setSelectionColor(color: ColorName): void;
  reorderSelection(direction: ReorderDirection): void;
  /** Everyone else on the board: their cursors and selections are drawn over the shapes. */
  setPeers(peers: readonly RemotePeer[]): void;
  undo(): void;
  redo(): void;
  /** Marks everything as changed; it is redrawn once, on the next animation frame. */
  invalidate(): void;
  /** Stops rendering and removes everything the engine added to the page. */
  destroy(): void;
}

interface Theme {
  gridDot: string;
  palette: Palette;
}

const DEFAULT_GRID_DOT = "#c4c6cf";
/** Assumed length of a frame when an animation starts from rest, in ms. */
const FRAME_MS = 1000 / 60;
/** A remote cursor this close to where it's heading lands on it, in CSS pixels. */
const CURSOR_SETTLE_PX = 0.25;
/** Longest remote name drawn on a cursor label. */
const MAX_LABEL_CHARS = 24;
/** Distance a duplicate is offset from the original, and arrow-key nudges, in world units. */
const DUPLICATE_OFFSET = 24;
const NUDGE = { small: 1, large: 10 };

/** The tools that work on a board that can't be edited. */
const VIEW_TOOLS: ReadonlySet<ToolName> = new Set(["select", "hand"]);

const TOOL_KEYS: Readonly<Record<string, ToolName>> = {
  v: "select",
  h: "hand",
  r: "rectangle",
  o: "ellipse",
  n: "sticky",
  l: "line",
};

/**
 * Mounts the engine into `container`, which it fills completely.
 *
 * The engine owns three stacked canvases: background (grid), shapes, and overlay
 * (selection, handles, marquee). Callers, React or anything else, only hand it
 * a container and a `DocStore`, and read its state through `getState` and
 * `subscribe`.
 */
export function createEngine(container: HTMLElement, options: EngineOptions): Engine {
  const { doc } = options;
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  container.style.touchAction = "none";
  container.style.userSelect = "none";
  container.style.overflow = "hidden";

  const background = new Layer(container, "background");
  const shapes = new Layer(container, "shapes");
  const overlay = new Layer(container, "overlay");
  const layers = [background, shapes, overlay];

  const scene = new Scene(doc);
  let state: EngineState = {
    camera: options.camera ?? { x: 0, y: 0, zoom: 1 },
    viewport: { width: 0, height: 0 },
    tool: "select",
    selection: [],
    selectionColor: null,
    shapeCount: scene.size,
    canUndo: doc.canUndo(),
    canRedo: doc.canRedo(),
    readOnly: doc.readOnly,
  };
  let cameraPlaced = options.camera !== undefined;
  let pixelRatio = window.devicePixelRatio || 1;
  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = readTheme(container, colorScheme.matches);
  let frame: number | null = null;
  let pendingWrite: (() => void) | null = null;
  const listeners = new Set<() => void>();
  let peers: readonly RemotePeer[] = [];
  const cursors = new SmoothedCursors();
  /** Timestamp of the last frame while remote cursors are moving; null at rest. */
  let lastFrameAt: number | null = null;
  /** The local mouse or pen, in screen coordinates, while it's over the board. */
  let pointer: Point | null = null;
  let reportedPointer: Point | null = null;

  const setState = (next: EngineState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const schedule = () => {
    frame ??= requestAnimationFrame(render);
  };

  const markDirty = (...dirty: Layer[]) => {
    for (const layer of dirty) layer.dirty = true;
    schedule();
  };
  const markAllDirty = () => markDirty(...layers);

  /** Tells `onPointerMove` where the pointer is on the board, when that changed. */
  const reportPointer = () => {
    if (!options.onPointerMove) return;
    const world = pointer && screenToWorld(state.camera, pointer);
    const last = reportedPointer;
    if (world === last || (world && last && world.x === last.x && world.y === last.y)) return;
    reportedPointer = world;
    options.onPointerMove(world);
  };

  const setCamera = (camera: Camera) => {
    const current = state.camera;
    if (camera.x === current.x && camera.y === current.y && camera.zoom === current.zoom) return;
    setState({ ...state, camera });
    markAllDirty();
    // Panning or zooming moves the board under a still pointer.
    reportPointer();
  };

  const selectionColorOf = (ids: readonly ShapeId[]): ColorName | null => {
    let color: ColorName | null = null;
    for (const id of ids) {
      const shape = scene.get(id);
      if (!shape) continue;
      if (color !== null && shape.color !== color) return null;
      color = shape.color;
    }
    return color;
  };

  const setSelection = (ids: readonly ShapeId[]) => {
    const next = [...new Set(ids)].filter((id) => scene.has(id));
    const current = state.selection;
    if (next.length === current.length && next.every((id, i) => id === current[i])) return;
    setState({ ...state, selection: next, selectionColor: selectionColorOf(next) });
    markDirty(overlay);
  };

  const selectedShapes = (): Shape[] =>
    state.selection.map((id) => scene.get(id)).filter((s): s is Shape => s !== undefined);

  const unsubscribeDoc = doc.subscribe((changes) => {
    scene.apply(changes);
    // Editing just stopped (the board filled up): drop any drawing tool.
    if (doc.readOnly && !VIEW_TOOLS.has(state.tool)) setTool("select");
    const selection = state.selection.filter((id) => scene.has(id));
    setState({
      ...state,
      selection: selection.length === state.selection.length ? state.selection : selection,
      selectionColor: selectionColorOf(selection),
      shapeCount: scene.size,
      canUndo: doc.canUndo(),
      canRedo: doc.canRedo(),
      readOnly: doc.readOnly,
    });
    markDirty(shapes, overlay);
  });

  const flushWrite = () => {
    const write = pendingWrite;
    pendingWrite = null;
    write?.();
  };

  const host: EditorHost = {
    doc,
    scene,
    camera: () => state.camera,
    tool: () => state.tool,
    setTool: (tool) => setTool(tool),
    selection: () => state.selection,
    setSelection,
    scheduleWrite(write) {
      pendingWrite = write;
      schedule();
    },
    flushWrite,
    overlayChanged: () => markDirty(overlay),
  };
  const interaction = new Interaction(host);

  function render(now: number) {
    // Gesture writes are applied once per frame, however many pointer events
    // arrived, which bounds the edits (and tombstones) a drag produces.
    flushWrite();
    frame = null;
    const { camera, viewport } = state;
    const pr = pixelRatio;

    const elapsed = lastFrameAt === null ? FRAME_MS : Math.min(now - lastFrameAt, 100);
    const cursorsMoved = cursors.step(elapsed, CURSOR_SETTLE_PX / camera.zoom);
    if (cursorsMoved) overlay.dirty = true;

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
      for (const shape of scene.ordered()) drawShape(ctx, shape, theme.palette);
      shapes.dirty = false;
    }

    if (overlay.dirty) {
      const ctx = overlay.ctx;
      ctx.setTransform(pr, 0, 0, pr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      drawOverlay(ctx);
      overlay.dirty = false;
    }

    // Keep drawing frames while remote cursors glide; stop once they've landed.
    if (cursorsMoved) {
      lastFrameAt = now;
      schedule();
    } else {
      lastFrameAt = null;
    }
  }

  /**
   * Selection, hover, marquee and other people's cursors and selections,
   * drawn in screen space so lines stay crisp at any zoom.
   */
  function drawOverlay(ctx: CanvasRenderingContext2D) {
    const { camera } = state;
    const { accent, handleFill } = theme.palette;
    const toScreen = (p: Point) => worldToScreen(camera, p);
    const outline = (points: Point[], close: boolean) => {
      ctx.beginPath();
      points.forEach((p, i) => {
        const s = toScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (close) ctx.closePath();
      ctx.stroke();
    };
    const outlineShape = (shape: Shape) => {
      if (shape.type !== "ellipse") {
        outline(shapeOutline(shape), shape.type !== "line");
        return;
      }
      const c = toScreen(shapeCenter(shape));
      ctx.beginPath();
      ctx.ellipse(
        c.x,
        c.y,
        (shape.w / 2) * camera.zoom,
        (shape.h / 2) * camera.zoom,
        shape.rotation,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    };
    ctx.lineWidth = 1.5;

    // Other people's selections go under ours.
    for (const peer of peers) {
      ctx.strokeStyle = peer.color;
      for (const id of peer.selection) {
        const shape = scene.get(id);
        if (shape) outlineShape(shape);
      }
    }

    ctx.strokeStyle = accent;
    const hovered = interaction.hovered();
    const hoveredShape =
      hovered && !state.selection.includes(hovered) ? scene.get(hovered) : undefined;
    if (hoveredShape) outlineShape(hoveredShape);

    const selected = selectedShapes();
    for (const shape of selected) outlineShape(shape);

    const frame: SelectionFrame | null = selectionFrame(selected);
    if (frame?.kind === "group") {
      const b = frame.bounds;
      ctx.setLineDash([4, 4]);
      outline(
        [
          { x: b.minX, y: b.minY },
          { x: b.maxX, y: b.minY },
          { x: b.maxX, y: b.maxY },
          { x: b.minX, y: b.maxY },
        ],
        true,
      );
      ctx.setLineDash([]);
    }
    if (frame && !state.readOnly && !interaction.busy()) {
      ctx.fillStyle = handleFill;
      for (const { target, at } of placeHandles(frame, camera)) {
        ctx.beginPath();
        if (target.kind === "resize") {
          const half = HANDLE_SIZE / 2;
          ctx.rect(at.x - half, at.y - half, HANDLE_SIZE, HANDLE_SIZE);
        } else {
          ctx.arc(at.x, at.y, HANDLE_SIZE / 2 + 1, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.stroke();
      }
    }

    const marquee = interaction.marquee();
    if (marquee) {
      const a = toScreen({ x: marquee.minX, y: marquee.minY });
      const b = toScreen({ x: marquee.maxX, y: marquee.maxY });
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.globalAlpha = 1;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }

    // Their cursors go over everything.
    for (const peer of peers) {
      const at = cursors.position(peer.id);
      if (at) drawCursor(ctx, toScreen(at), peer);
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
    setState({ ...state, camera, viewport });
    schedule();
  };

  const viewportCenter = () => ({ x: state.viewport.width / 2, y: state.viewport.height / 2 });

  const zoomStep = (direction: 1 | -1) => {
    const camera = state.camera;
    setCamera(zoomAt(camera, viewportCenter(), nextZoomStep(camera.zoom, direction)));
  };

  const resetZoom = () => setCamera(zoomAt(state.camera, viewportCenter(), 1));

  function setTool(tool: ToolName) {
    if (tool === state.tool || (doc.readOnly && !VIEW_TOOLS.has(tool))) return;
    interaction.cancel();
    setState({ ...state, tool });
    input.refreshCursor();
    markDirty(overlay);
  }

  /** Runs one editing command as its own undo step. */
  const command = (fn: Parameters<DocStore["transact"]>[0]) => {
    if (doc.readOnly) return;
    doc.checkpoint();
    doc.transact(fn);
    doc.checkpoint();
  };

  const setPeers = (next: readonly RemotePeer[]) => {
    peers = next;
    cursors.retarget(next);
    markDirty(overlay);
  };

  const pointerMoved = (screen: Point | null) => {
    pointer = screen;
    reportPointer();
  };

  const deleteSelection = () => {
    const ids = state.selection;
    if (ids.length === 0) return;
    command((tx) => {
      for (const id of ids) tx.remove(id);
    });
  };

  const duplicateSelection = () => {
    const originals = selectedShapes();
    if (originals.length === 0 || doc.readOnly) return;
    const keys = indexesAbove(scene.ordered(), originals.length);
    const copies = originals.map((shape, i) => ({
      ...shape,
      ...translate(shape, DUPLICATE_OFFSET, DUPLICATE_OFFSET),
      id: newShapeId(),
      index: keys[i] as string,
    }));
    command((tx) => {
      for (const copy of copies) tx.add(copy);
    });
    setSelection(copies.map((c) => c.id));
  };

  const setSelectionColor = (color: ColorName) => {
    const ids = state.selection;
    command((tx) => {
      for (const id of ids) tx.update(id, { color });
    });
  };

  const reorderSelection = (direction: ReorderDirection) => {
    const selected = new Set<string>(state.selection);
    if (selected.size === 0) return;
    const ordered = scene.ordered();
    const keys =
      direction === "forward" || direction === "backward"
        ? reorderStep(ordered, selected, direction === "forward" ? 1 : -1)
        : reorderToEnd(ordered, selected, direction === "front" ? 1 : -1);
    command((tx) => {
      for (const [id, index] of keys) tx.update(id as ShapeId, { index });
    });
  };

  const nudge = (dx: number, dy: number) => {
    const before = selectedShapes();
    if (before.length === 0 || doc.readOnly) return;
    // Consecutive nudges merge into one undo step, like a drag.
    doc.transact((tx) => {
      for (const shape of before) tx.update(shape.id, translate(shape, dx, dy));
    });
  };

  const undo = () => {
    interaction.cancel();
    doc.undo();
  };
  const redo = () => {
    interaction.cancel();
    doc.redo();
  };

  const keyDown = (event: KeyboardEvent): boolean => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      if (interaction.cancel()) return true;
      if (state.selection.length > 0) {
        setSelection([]);
        return true;
      }
      if (state.tool !== "select") {
        setTool("select");
        return true;
      }
      return false;
    }
    // Shortcuts would fight with a drag in progress.
    if (interaction.busy()) return false;

    if (mod && !event.altKey) {
      if (key === "z") event.shiftKey ? redo() : undo();
      else if (key === "y") redo();
      else if (key === "a") selectAll();
      else if (key === "d") duplicateSelection();
      else return false;
      return true;
    }
    if (mod || event.altKey) return false;

    if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selection.length === 0) return false;
      deleteSelection();
      return true;
    }
    if (event.code === "BracketRight") {
      reorderSelection(event.shiftKey ? "front" : "forward");
      return true;
    }
    if (event.code === "BracketLeft") {
      reorderSelection(event.shiftKey ? "back" : "backward");
      return true;
    }
    const step = event.shiftKey ? NUDGE.large : NUDGE.small;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const arrow = arrows[event.key];
    if (arrow && state.selection.length > 0) {
      nudge(...arrow);
      return true;
    }
    const tool = TOOL_KEYS[key];
    if (tool && !event.shiftKey && !event.repeat) {
      setTool(tool);
      return true;
    }
    return false;
  };

  const selectAll = () => setSelection(scene.ordered().map((s) => s.id));

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

  const onColorSchemeChange = () => {
    theme = readTheme(container, colorScheme.matches);
    markAllDirty();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  watchPixelRatio();
  colorScheme.addEventListener("change", onColorSchemeChange);
  resize();

  const input: InputController = new InputController({
    container,
    getCamera: () => state.camera,
    setCamera,
    getViewport: () => state.viewport,
    zoomStep,
    resetZoom,
    primaryDragPans: () => state.tool === "hand",
    toolDown: (pointer) => interaction.pointerDown(pointer),
    toolMove: (pointer) => interaction.pointerMove(pointer),
    toolUp: (pointer) => interaction.pointerUp(pointer),
    toolHover: (pointer) => interaction.hover(pointer),
    toolCancel: () => interaction.cancel(),
    keyDown,
    toolCursor: () => interaction.cursor(),
    pointerMoved,
  });

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
    setTool,
    select: setSelection,
    selectAll,
    deleteSelection,
    duplicateSelection,
    setSelectionColor,
    reorderSelection,
    setPeers,
    undo,
    redo,
    invalidate: markAllDirty,
    destroy() {
      interaction.cancel();
      input.destroy();
      unsubscribeDoc();
      observer.disconnect();
      pixelRatioQuery?.removeEventListener("change", onPixelRatioChange);
      colorScheme.removeEventListener("change", onColorSchemeChange);
      if (frame !== null) cancelAnimationFrame(frame);
      for (const layer of layers) layer.destroy();
      listeners.clear();
    },
  };
}

/** An arrow pointer, tip at the origin, in CSS pixels. */
const POINTER_ARROW: readonly [number, number][] = [
  [0, 0],
  [0, 17],
  [4.6, 12.9],
  [7.6, 19.6],
  [10.6, 18.3],
  [7.7, 11.8],
  [13.6, 11.8],
];

/** Someone else's pointer, with their name beside it. */
function drawCursor(ctx: CanvasRenderingContext2D, at: Point, peer: RemotePeer): void {
  ctx.save();
  ctx.translate(Math.round(at.x), Math.round(at.y));
  ctx.beginPath();
  for (const [x, y] of POINTER_ARROW) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = peer.color;
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  const name =
    peer.name.length > MAX_LABEL_CHARS ? `${peer.name.slice(0, MAX_LABEL_CHARS - 1)}…` : peer.name;
  if (name) {
    ctx.font = "500 12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const width = ctx.measureText(name).width + 12;
    ctx.beginPath();
    ctx.roundRect(12, 18, width, 20, 6);
    ctx.fillStyle = peer.color;
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(name, 18, 28);
  }
  ctx.restore();
}

function readTheme(container: HTMLElement, dark: boolean): Theme {
  const style = getComputedStyle(container);
  return {
    gridDot: style.getPropertyValue("--grid-dot").trim() || DEFAULT_GRID_DOT,
    palette: dark ? DARK_PALETTE : LIGHT_PALETTE,
  };
}
