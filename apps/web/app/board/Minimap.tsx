import {
  centerOn,
  type Engine,
  fitOverview,
  type OverviewFit,
  overviewToWorld,
  visibleBounds,
  worldToOverview,
} from "@niro/engine";
import { useCallback, useEffect, useRef, useState } from "react";
import { MapIcon } from "./icons";
import { useEngineState } from "./useEngineState";

const WIDTH = 200;
const HEIGHT = 130;
const STORAGE_KEY = "niro.minimap";

/** Shown by default except on small screens, where it would cover the board; the choice is remembered. */
function initialOpen(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved === "open";
  } catch {
    // Storage can be blocked; the default stands.
  }
  return window.matchMedia?.("(min-width: 900px)").matches ?? true;
}

function remember(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** The whole board drawn small, with the part on screen outlined: click or drag to go there. */
export function Minimap({ engine }: { engine: Engine }) {
  const [open, setOpen] = useState(initialOpen);
  const empty = useEngineState(engine, (s) => s.shapeCount === 0, true);
  const choose = useCallback((next: boolean) => {
    setOpen(next);
    remember(next);
  }, []);

  if (empty) return null;
  if (!open) {
    return (
      <div className="panel minimap-toggle">
        <button
          type="button"
          aria-label="Show minimap"
          title="Show minimap"
          data-testid="minimap-show"
          onClick={() => choose(true)}
        >
          <MapIcon />
        </button>
      </div>
    );
  }
  return <MinimapView engine={engine} onHide={() => choose(false)} />;
}

function MinimapView({ engine, onHide }: { engine: Engine; onHide: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The fit a drag started with: the map stays put under the pointer while the view moves. */
  const dragFit = useRef<OverviewFit | null>(null);

  const fitNow = useCallback((): OverviewFit => {
    const { camera, viewport } = engine.getState();
    return fitOverview(engine.overview().bounds, visibleBounds(camera, viewport), WIDTH, HEIGHT);
  }, [engine]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    el.width = WIDTH * ratio;
    el.height = HEIGHT * ratio;
    let frame: number | null = null;

    const draw = () => {
      frame = null;
      const { camera, viewport } = engine.getState();
      const fit = dragFit.current ?? fitNow();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      for (const item of engine.overview().items) {
        const a = worldToOverview(fit, { x: item.minX, y: item.minY });
        const b = worldToOverview(fit, { x: item.maxX, y: item.maxY });
        const w = Math.max(1.5, b.x - a.x);
        const h = Math.max(1.5, b.y - a.y);
        if (a.x + w < 0 || a.y + h < 0 || a.x > WIDTH || a.y > HEIGHT) continue;
        ctx.fillStyle = item.fill;
        if (item.kind === "frame") {
          ctx.globalAlpha = 0.35;
          ctx.fillRect(a.x, a.y, w, h);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillRect(a.x, a.y, w, h);
        }
      }
      const view = visibleBounds(camera, viewport);
      const tl = worldToOverview(fit, { x: view.minX, y: view.minY });
      const br = worldToOverview(fit, { x: view.maxX, y: view.maxY });
      const accent = getComputedStyle(el).getPropertyValue("--accent").trim() || "#2563eb";
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    };

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(draw);
    };
    schedule();
    const unsubscribe = engine.subscribe(schedule);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [engine, fitNow]);

  const goTo = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fit = dragFit.current ?? fitNow();
    const world = overviewToWorld(fit, {
      x: ((event.clientX - box.left) / box.width) * WIDTH,
      y: ((event.clientY - box.top) / box.height) * HEIGHT,
    });
    const { camera, viewport } = engine.getState();
    engine.setCamera(centerOn(world, viewport, camera.zoom));
  };

  return (
    <div className="panel minimap" data-testid="minimap">
      <canvas
        ref={canvas}
        style={{ width: WIDTH, height: HEIGHT }}
        role="img"
        aria-label="Minimap of the board: click or drag to move the view"
        data-testid="minimap-canvas"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragFit.current = fitNow();
          goTo(event);
        }}
        onPointerMove={(event) => {
          if (dragFit.current) goTo(event);
        }}
        onPointerUp={() => {
          dragFit.current = null;
          // Redraw with the map refitted to where the view ended up.
          engine.invalidate();
        }}
        onPointerCancel={() => {
          dragFit.current = null;
        }}
      />
      <button
        type="button"
        className="minimap-hide"
        aria-label="Hide minimap"
        title="Hide minimap"
        data-testid="minimap-hide"
        onClick={onHide}
      >
        ×
      </button>
    </div>
  );
}
