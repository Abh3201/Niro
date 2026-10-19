import type { Engine } from "@niro/engine";
import { useEngineState } from "./useEngineState";

/** Zoom out / current zoom (click to reset) / zoom in, and the shortcuts list. */
export function ZoomControls({ engine, onHelp }: { engine: Engine; onHelp: () => void }) {
  // Select just the zoom level, so panning doesn't re-render this component.
  const zoom = useEngineState(engine, (s) => s.camera.zoom, 1);
  const percent = Math.round(zoom * 100);

  return (
    <div className="panel zoom-controls" role="toolbar" aria-label="Zoom">
      <button
        type="button"
        onClick={engine.zoomOut}
        aria-label="Zoom out"
        title="Zoom out (Ctrl -)"
      >
        −
      </button>
      <button
        type="button"
        onClick={engine.resetZoom}
        aria-label={`Zoom ${percent}%, reset to 100%`}
        title="Reset to 100% (Ctrl 0)"
        data-testid="zoom-level"
      >
        {percent}%
      </button>
      <button type="button" onClick={engine.zoomIn} aria-label="Zoom in" title="Zoom in (Ctrl =)">
        +
      </button>
      <span className="divider" aria-hidden="true" />
      <button
        type="button"
        onClick={onHelp}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        data-testid="shortcuts-button"
      >
        ?
      </button>
    </div>
  );
}
