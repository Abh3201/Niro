/**
 * The engine on a seeded board, with scenarios Playwright runs and times
 * (see `bench.spec.ts`). Query: `?shapes=10000&seed=1`.
 */
import { indexesBetween, type Shape, type ShapeId } from "@niro/doc";
import { createYDocStore } from "@niro/doc/yjs";
import { benchmarkBoard, type Camera, createEngine, type FrameStats } from "@niro/engine";
import * as Y from "yjs";

export interface ScenarioResult {
  readonly name: string;
  readonly frames: number;
  /** Per-frame cost, in ms: the engine's JavaScript plus waiting for the canvas to finish. */
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /** The engine's JavaScript alone, median. */
  readonly scriptP50: number;
  /** Shapes drawn per frame, on average. */
  readonly drawn: number;
}

declare global {
  interface Window {
    niroBench: {
      ready: boolean;
      shapes: number;
      run(): Promise<ScenarioResult[]>;
      /** Shows the middle of the board at `zoom`, for looking at. */
      view(zoom: number): void;
    };
  }
}

const params = new URLSearchParams(location.search);
const count = Number(params.get("shapes") ?? 10_000);
const seed = Number(params.get("seed") ?? 1);
const container = document.getElementById("board") as HTMLElement;

const shapes = benchmarkBoard(count, seed);
const doc = createYDocStore(new Y.Doc());
doc.transact((tx) => {
  for (const shape of shapes) tx.add(shape);
});

let last: FrameStats | null = null;
const engine = createEngine(container, {
  doc,
  onFrame: (stats) => {
    last = stats;
  },
});

// Top-level shapes are where they are on the board; everything else is in a frame.
let minX = Number.POSITIVE_INFINITY;
let minY = Number.POSITIVE_INFINITY;
let maxX = Number.NEGATIVE_INFINITY;
let maxY = Number.NEGATIVE_INFINITY;
for (const s of shapes) {
  if (s.parentId !== null) continue;
  minX = Math.min(minX, s.x, s.x + s.w);
  minY = Math.min(minY, s.y, s.y + s.h);
  maxX = Math.max(maxX, s.x, s.x + s.w);
  maxY = Math.max(maxY, s.y, s.y + s.h);
}
const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

// The middle of the frame nearest the board's center: full of notes.
const frames = shapes.filter((s) => s.type === "frame");
const middle = (s: (typeof shapes)[number]) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
const distance = (s: (typeof shapes)[number]) =>
  Math.hypot(middle(s).x - center.x, middle(s).y - center.y);
const start = middle(frames.reduce((a, b) => (distance(b) < distance(a) ? b : a)));

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const shapesCanvas = container.querySelector<HTMLCanvasElement>('canvas[data-layer="shapes"]');
const overlay = container.querySelector<HTMLCanvasElement>('canvas[data-layer="overlay"]');

/** Waits for the canvas to finish drawing: reading a pixel back makes the browser rasterize now. */
function finishCanvas(): number {
  const started = performance.now();
  shapesCanvas?.getContext("2d")?.getImageData(0, 0, 1, 1);
  return performance.now() - started;
}

/** Camera with world point `p` at the middle of the screen. */
function cameraAt(p: { x: number; y: number }, zoom: number): Camera {
  const { width, height } = engine.getState().viewport;
  return { x: p.x - width / 2 / zoom, y: p.y - height / 2 / zoom, zoom };
}

async function measure(
  name: string,
  frames: number,
  step: (i: number) => void,
): Promise<ScenarioResult> {
  const totals: number[] = [];
  const scripts: number[] = [];
  let drawn = 0;
  // Two frames to settle what the scenario starts from.
  step(0);
  await nextFrame();
  await nextFrame();
  for (let i = 1; i <= frames; i++) {
    last = null;
    const started = performance.now();
    step(i);
    const input = performance.now() - started;
    await nextFrame();
    const flush = finishCanvas();
    const frame = last as FrameStats | null;
    const script = input + (frame?.ms ?? 0);
    scripts.push(script);
    totals.push(script + flush);
    drawn += frame?.drawn ?? 0;
  }
  const sorted = [...totals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return {
    name,
    frames,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
    scriptP50: round([...scripts].sort((a, b) => a - b)[Math.floor(scripts.length / 2)] ?? 0),
    drawn: Math.round(drawn / frames),
  };
}

async function run(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  // Panning moves 12 screen pixels a frame, whatever the zoom.
  results.push(
    await measure("pan at 100%", 120, (i) =>
      engine.setCamera(cameraAt({ x: start.x + i * 12, y: start.y }, 1)),
    ),
  );
  results.push(
    await measure("pan at 25%", 120, (i) =>
      engine.setCamera(cameraAt({ x: start.x + i * 48, y: start.y }, 0.25)),
    ),
  );
  results.push(
    await measure("pan fully zoomed out (5%)", 120, (i) =>
      engine.setCamera(cameraAt({ x: center.x + i * 240, y: center.y }, 0.05)),
    ),
  );
  results.push(
    await measure("zoom from 5% to 100% and back", 120, (i) => {
      const t = Math.abs((i % 120) / 60 - 1);
      engine.setCamera(cameraAt(center, 0.05 + 0.95 * (1 - t)));
    }),
  );
  // Edits, as a collaborator's arrive: moving one note, then adding notes.
  engine.setCamera(cameraAt(start, 0.25));
  const loose = shapes.find((s) => s.type === "sticky" && s.parentId === null) as Shape;
  results.push(
    await measure("move a note at 25%", 120, (i) =>
      doc.transact((tx) => tx.update(loose.id, { x: start.x + (i % 60) * 10, y: start.y })),
    ),
  );
  // New notes go on top of the board.
  const top = shapes.reduce((max, s) => (s.parentId === null && s.index > max ? s.index : max), "");
  const keys = indexesBetween(top, null, 120);
  results.push(
    await measure("add a note at 25%", 120, (i) =>
      doc.transact((tx) =>
        tx.add({
          ...loose,
          id: `added-${i}` as ShapeId,
          x: start.x + (i % 12) * 220,
          y: start.y + Math.floor(i / 12) * 220,
          index: keys[i - 1] as string,
        }),
      ),
    ),
  );
  // The pointer sweeping over a busy part of the board, as when hovering.
  const { width, height } = engine.getState().viewport;
  results.push(
    await measure("hover at 25%", 120, (i) => {
      overlay?.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          clientX: (i * 37) % width,
          clientY: (i * 23) % height,
        }),
      );
    }),
  );
  return results;
}

window.niroBench = {
  ready: true,
  shapes: shapes.length,
  run,
  view: (zoom) => engine.setCamera(cameraAt(start, zoom)),
};
