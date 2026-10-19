import {
  type ColorName,
  DEFAULT_COLOR,
  type DocStore,
  holdsText,
  isLinear,
  type Shape,
  type ShapeId,
} from "@niro/doc";
import { describeShape, nextInReadingOrder, ShapeList } from "./a11y";
import { asDrawn, detachUnless } from "./arrows";
import { transact } from "./board-tx";
import {
  type Camera,
  centerOn,
  nextZoomStep,
  screenToWorld,
  visibleBounds,
  worldToScreen,
  zoomAt,
} from "./camera";
import { exportPng, exportSvg } from "./export";
import { StrokePaths, strokeOutline, traceOutline } from "./freehand";
import type { Point, Viewport } from "./geometry";
import { drawGrid } from "./grid";
import { InputController } from "./input";
import { type EditorHost, Interaction, type ToolName } from "./interaction";
import { Layer } from "./layers";
import { paintShapes } from "./paint";
import { type RemotePeer, SmoothedCursors } from "./presence";
import { DARK_PALETTE, drawnExtent, LIGHT_PALETTE, type Palette } from "./render";
import { Scene } from "./scene";
import { HANDLE_SIZE, placeHandles } from "./selection";
import { shapeBounds, shapeCenter, shapeOutline } from "./shapes";
import {
  duplicate,
  group,
  movers,
  outermost,
  remove,
  reorder,
  reparentOnMove,
  sharedColor,
  styleTargets,
  ungroup,
  withDescendants,
} from "./structure";
import { canvasFontMetrics, TextLayouts } from "./text";
import { TextEditor } from "./text-editor";
import { translate } from "./transform";

export type { ToolName } from "./interaction";

export interface EngineState {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly tool: ToolName;
  /** Selected shape ids. Local to this user: selection never goes into the document. */
  readonly selection: readonly ShapeId[];
  /**
   * The color every selected shape shares (for a group, every shape in it),
   * or null when mixed or nothing is selected.
   */
  readonly selectionColor: ColorName | null;
  /** Two or more shapes are selected, so they can be grouped. */
  readonly canGroup: boolean;
  /** A group is selected, so it can be taken apart. */
  readonly canUngroup: boolean;
  readonly shapeCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /**
   * The board can't be edited: the key only grants viewing, the board was
   * saved by a newer version of Niro, or the server takes no more changes.
   */
  readonly readOnly: boolean;
  /** The shape whose text is being edited, if any. */
  readonly editing: ShapeId | null;
  /** Words for the selected shape, for screen readers; empty unless one shape is selected. */
  readonly selectionLabel: string;
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
  /**
   * Called after every frame the engine draws: for benchmarks and
   * debugging. Drawing commands are queued in that time; the browser may
   * rasterize them later, off the main thread.
   */
  onFrame?: (stats: FrameStats) => void;
  /** Light or dark board; null or absent follows the system setting. See `Engine.setColorScheme`. */
  colorScheme?: ColorScheme | null;
}

export type ColorScheme = "light" | "dark";

export interface FrameStats {
  /** Time spent in the frame's JavaScript, in ms. */
  readonly ms: number;
  /** Shapes drawn: none when only the overlay changed, fewer than all when some were off screen. */
  readonly drawn: number;
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
  /** Puts the selected shapes in a group, and selects it. */
  groupSelection(): void;
  /** Takes the selected groups apart, and selects what was in them. */
  ungroupSelection(): void;
  /** Starts editing a shape's text, in place. Lines have none. */
  editText(id: ShapeId): void;
  /** Everyone else on the board: their cursors and selections are drawn over the shapes. */
  setPeers(peers: readonly RemotePeer[]): void;
  undo(): void;
  redo(): void;
  /**
   * The selection, or the whole board when nothing is selected, as a PNG or
   * an SVG image: light colors on white, whatever the theme. Null when
   * there's nothing to export.
   */
  exportImage(format: "png" | "svg"): Promise<Blob | null>;
  /**
   * Draws the board light or dark, or with null, as the system setting says.
   * The page's CSS has to switch with it: the grid's dots are the
   * container's `--grid-dot` color, read when this is called.
   */
  setColorScheme(scheme: ColorScheme | null): void;
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
/** Behind exported images. */
const EXPORT_BACKGROUND = "#ffffff";
/** Shown in place of a frame's name until it has one. */
const FRAME_PLACEHOLDER = "Frame";
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
  a: "arrow",
  t: "text",
  p: "pen",
  f: "frame",
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
  // The board takes keyboard focus, and its own keys: screen readers pass
  // them through to an application rather than reading with them.
  if (!container.hasAttribute("tabindex")) container.tabIndex = 0;
  container.setAttribute("role", "application");
  container.setAttribute("aria-roledescription", "whiteboard");
  if (!container.hasAttribute("aria-label")) container.setAttribute("aria-label", "Board");

  const background = new Layer(container, "background");
  const shapes = new Layer(container, "shapes");
  const overlay = new Layer(container, "overlay");
  const layers = [background, shapes, overlay];

  const fonts = canvasFontMetrics();
  const layouts = new TextLayouts(fonts.measure);
  const strokes = new StrokePaths();
  /** A shape as drawn: an unnamed frame shows a placeholder name. */
  const labelled = (shape: Shape): Shape =>
    shape.type === "frame" && shape.text === "" ? { ...shape, text: FRAME_PLACEHOLDER } : shape;
  const textLayout = (shape: Shape) => {
    const drawn = labelled(shape);
    return drawn.text === "" ? undefined : layouts.get(drawn);
  };
  // Text in a sticky note, box or ellipse shrinks to fit inside it; only a
  // text shape's text and a frame's name can reach past the outline.
  const scene = new Scene(doc, {
    extent: (shape) =>
      drawnExtent(
        shape,
        shape.type === "text" || shape.type === "frame" ? textLayout(shape) : undefined,
      ),
  });
  let state: EngineState = {
    camera: options.camera ?? { x: 0, y: 0, zoom: 1 },
    viewport: { width: 0, height: 0 },
    tool: "select",
    selection: [],
    selectionColor: null,
    canGroup: false,
    canUngroup: false,
    shapeCount: scene.size,
    canUndo: doc.canUndo(),
    canRedo: doc.canRedo(),
    readOnly: doc.readOnly,
    editing: null,
    selectionLabel: "",
  };
  let cameraPlaced = options.camera !== undefined;
  let pixelRatio = window.devicePixelRatio || 1;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  let colorScheme = options.colorScheme ?? null;
  const isDark = () => (colorScheme ?? (systemDark.matches ? "dark" : "light")) === "dark";
  let theme = readTheme(container, isDark());
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

  /** What the panel shows about a selection. */
  const describe = (ids: readonly ShapeId[]) => ({
    selectionColor: sharedColor(scene, ids),
    canGroup: outermost(scene, ids).length >= 2,
    canUngroup: ids.some((id) => scene.get(id)?.type === "group"),
    selectionLabel: ids.length === 1 ? describeShape(scene, ids[0] as ShapeId) : "",
  });

  const setSelection = (ids: readonly ShapeId[]) => {
    const next = [...new Set(ids)].filter((id) => scene.has(id));
    const current = state.selection;
    if (next.length === current.length && next.every((id, i) => id === current[i])) return;
    setState({ ...state, selection: next, ...describe(next) });
    markDirty(overlay);
  };

  const selectedShapes = (): Shape[] =>
    state.selection.map((id) => scene.get(id)).filter((s): s is Shape => s !== undefined);

  const editor = new TextEditor({
    container,
    doc,
    shape: (id) => scene.get(id),
    transact: (fn) => transact(doc, scene, fn),
    layouts,
    camera: () => state.camera,
    palette: () => theme.palette,
    changed() {
      const editing = editor.editing;
      if (editing !== null && scene.has(editing)) setSelection([editing]);
      if (editing !== state.editing) setState({ ...state, editing });
      markDirty(shapes, overlay);
    },
    undo: () => undo(),
    redo: () => redo(),
  });

  const shapeList = new ShapeList(container, scene);
  // A press on the board gives it keyboard focus (not a press in the text
  // editor, which keeps its own).
  const focusBoard = (event: PointerEvent) => {
    if (event.target !== container && !(event.target instanceof HTMLCanvasElement)) return;
    if (document.activeElement !== container) container.focus({ preventScroll: true });
  };
  container.addEventListener("pointerdown", focusBoard);

  const unsubscribeDoc = doc.subscribe((changes) => {
    scene.apply(changes);
    shapeList.changed();
    // Editing just stopped (the board filled up): drop any drawing tool.
    if (doc.readOnly && !VIEW_TOOLS.has(state.tool)) setTool("select");
    if (doc.readOnly) editor.stop();
    const selection = state.selection.filter((id) => scene.has(id));
    setState({
      ...state,
      selection: selection.length === state.selection.length ? state.selection : selection,
      ...describe(selection),
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
    transact: (fn) => transact(doc, scene, fn),
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
    startEditing: (id) => editText(id),
    startDraft(shape) {
      setSelection([]);
      editor.start(shape, true);
    },
    fittedHeight: (shape) => layouts.fittedHeight(shape),
  };
  const interaction = new Interaction(host);

  function render(now: number) {
    // Gesture writes are applied once per frame, however many pointer events
    // arrived, which bounds the edits (and tombstones) a drag produces.
    const started = performance.now();
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

    let drawn = 0;
    if (shapes.dirty) {
      const ctx = shapes.ctx;
      ctx.setTransform(pr, 0, 0, pr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      // World -> device pixels: scale by zoom and pixel ratio, shift by the camera.
      const scale = pr * camera.zoom;
      ctx.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);
      const editing = editor.editing;
      drawn = paintShapes(ctx, scene.visible(visibleBounds(camera, viewport)), {
        scene,
        palette: theme.palette,
        zoom: camera.zoom,
        baseline: fonts.baseline,
        // The editor shows the text of the shape being edited.
        textLayout: (shape) => (shape.id === editing ? undefined : textLayout(shape)),
        stroke: (shape) => strokes.get(shape),
      });
      shapes.dirty = false;
      // Shapes or the camera moved: the editor moves with them.
      editor.update();
    }

    if (overlay.dirty) {
      const ctx = overlay.ctx;
      ctx.setTransform(pr, 0, 0, pr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      drawOverlay(ctx);
      overlay.dirty = false;
    }

    options.onFrame?.({ ms: performance.now() - started, drawn });

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
        outline(shapeOutline(shape), !isLinear(shape.type));
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
    // Nothing in the selection gets a hover outline, including what's in a selected group.
    const hovered = interaction.hovered();
    const inSelection = (id: ShapeId) =>
      state.selection.includes(id) ||
      scene.ancestorsOf(id).some((a) => state.selection.includes(a));
    const hoveredShape = hovered && !inSelection(hovered) ? scene.get(hovered) : undefined;
    if (hoveredShape) outlineShape(hoveredShape);

    const selected = selectedShapes();
    for (const shape of selected) outlineShape(shape);

    const frame = interaction.frame();
    // Several shapes get a dashed box around them all; a group has its own outline.
    if (frame?.kind === "group" && selected.length > 1) {
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
    if (frame && !state.readOnly && !interaction.busy() && state.editing === null) {
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

    // The shape an arrow end being dragged would attach to.
    const target = interaction.attachTarget();
    const targetShape = target === null ? undefined : scene.get(target);
    if (targetShape) {
      ctx.lineWidth = 3;
      outlineShape(targetShape);
      ctx.lineWidth = 1.5;
    }

    // A pen stroke being drawn: in the overlay until it's finished.
    const drawing = interaction.drawing();
    if (drawing) {
      ctx.save();
      ctx.setTransform(
        pixelRatio * camera.zoom,
        0,
        0,
        pixelRatio * camera.zoom,
        -camera.x * camera.zoom * pixelRatio,
        -camera.y * camera.zoom * pixelRatio,
      );
      ctx.beginPath();
      traceOutline(ctx, strokeOutline(drawing, false));
      ctx.fillStyle = theme.palette.solid[DEFAULT_COLOR.freehand];
      ctx.fill();
      ctx.restore();
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
    transact(doc, scene, fn);
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
    command((tx) => remove(scene, tx, ids));
  };

  const duplicateSelection = () => {
    const ids = state.selection;
    if (ids.length === 0 || doc.readOnly) return;
    let copies: ShapeId[] = [];
    command((tx) => {
      copies = duplicate(scene, tx, ids, DUPLICATE_OFFSET);
    });
    setSelection(copies);
  };

  const setSelectionColor = (color: ColorName) => {
    const ids = styleTargets(scene, state.selection);
    command((tx) => {
      for (const id of ids) tx.update(id, { color });
    });
  };

  const reorderSelection = (direction: ReorderDirection) => {
    if (state.selection.length === 0) return;
    const keys = reorder(scene, state.selection, direction);
    command((tx) => {
      for (const [id, index] of keys) tx.update(id, { index });
    });
  };

  const groupSelection = () => {
    if (!state.canGroup || doc.readOnly) return;
    let id: ShapeId | null = null;
    command((tx) => {
      id = group(scene, tx, state.selection);
    });
    if (id !== null) setSelection([id]);
  };

  const ungroupSelection = () => {
    if (!state.canUngroup || doc.readOnly) return;
    let freed: ShapeId[] = [];
    command((tx) => {
      freed = ungroup(scene, tx, state.selection);
    });
    setSelection(freed);
  };

  function editText(id: ShapeId) {
    const shape = scene.get(id);
    if (!shape || !holdsText(shape.type) || doc.readOnly) return;
    interaction.cancel();
    editor.start(shape);
  }

  const nudge = (dx: number, dy: number) => {
    const units = outermost(scene, state.selection)
      .map((id) => scene.get(id))
      .filter((s): s is Shape => s !== undefined);
    if (units.length === 0 || doc.readOnly) return;
    const moving = new Set(withDescendants(scene, state.selection));
    const membership = reparentOnMove(scene, units, moving, dx, dy);
    // Consecutive nudges merge into one undo step, like a drag.
    transact(doc, scene, (tx) => {
      for (const id of movers(scene, state.selection)) {
        const shape = scene.get(id);
        if (!shape) continue;
        tx.update(id, {
          ...asDrawn(shape),
          ...translate(shape, dx, dy),
          ...detachUnless(shape, (target) => moving.has(target)),
        });
      }
      for (const [id, patch] of membership) tx.update(id, patch);
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

  /** Pans to shape `id` if any of it is off screen. */
  const bringIntoView = (id: ShapeId) => {
    const shape = scene.get(id);
    if (!shape) return;
    const box = shapeBounds(shape);
    const view = visibleBounds(state.camera, state.viewport);
    if (
      box.minX >= view.minX &&
      box.minY >= view.minY &&
      box.maxX <= view.maxX &&
      box.maxY <= view.maxY
    )
      return;
    const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    setCamera(centerOn(center, state.viewport, state.camera.zoom));
  };

  /**
   * Tab and Shift + Tab on the board step through shapes in reading order.
   * Past the last (or first) shape the selection clears and the browser
   * moves focus on as usual, so the keyboard never gets stuck on the board.
   */
  const stepSelection = (event: KeyboardEvent): boolean => {
    if (event.target !== container && event.target !== document.body) return false;
    const current = state.selection.at(event.shiftKey ? 0 : -1) ?? null;
    const next = nextInReadingOrder(scene, current, event.shiftKey ? -1 : 1);
    if (next === null) {
      setSelection([]);
      return false;
    }
    setSelection([next]);
    bringIntoView(next);
    if (document.activeElement !== container) container.focus({ preventScroll: true });
    return true;
  };

  const keyDown = (event: KeyboardEvent): boolean => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === "Tab" && !mod && !event.altKey) {
      if (interaction.busy()) return false;
      return stepSelection(event);
    }
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
      else if (key === "g") event.shiftKey ? ungroupSelection() : groupSelection();
      else return false;
      return true;
    }
    if (mod || event.altKey) return false;

    if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selection.length === 0) return false;
      deleteSelection();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && state.selection.length === 1) {
      const id = state.selection[0] as ShapeId;
      if (!holdsText(scene.get(id)?.type ?? "line")) return false;
      editText(id);
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

  /** Everything at the top level: what's in groups and frames comes with them. */
  const selectAll = () => setSelection(scene.childrenOf(null));

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
    theme = readTheme(container, isDark());
    markAllDirty();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  watchPixelRatio();
  systemDark.addEventListener("change", onColorSchemeChange);
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
    doubleClick: (pointer) => interaction.doubleClick(pointer),
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
    groupSelection,
    ungroupSelection,
    editText,
    setPeers,
    undo,
    redo,
    exportImage(format) {
      const input = {
        scene,
        ids: state.selection.length > 0 ? state.selection : null,
        palette: LIGHT_PALETTE,
        background: EXPORT_BACKGROUND,
        baseline: fonts.baseline,
        textLayout,
        stroke: (shape: Shape) => strokes.get(shape),
      };
      if (format === "png") return exportPng(input);
      const svg = exportSvg(input);
      return Promise.resolve(svg === null ? null : new Blob([svg], { type: "image/svg+xml" }));
    },
    setColorScheme(scheme) {
      colorScheme = scheme;
      onColorSchemeChange();
    },
    invalidate: markAllDirty,
    destroy() {
      interaction.cancel();
      editor.stop();
      input.destroy();
      unsubscribeDoc();
      shapeList.destroy();
      container.removeEventListener("pointerdown", focusBoard);
      observer.disconnect();
      pixelRatioQuery?.removeEventListener("change", onPixelRatioChange);
      systemDark.removeEventListener("change", onColorSchemeChange);
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
