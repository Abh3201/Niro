import type { Engine } from "@niro/engine";
import { useEngineState } from "./useEngineState";

/**
 * While presenting: where you are in the slides, and buttons for the keys
 * (arrows, Page Up and Down, Esc). The buttons don't take focus, so the
 * board keeps hearing the keys.
 */
export function PresentControls({ engine }: { engine: Engine }) {
  const presenting = useEngineState(engine, (s) => s.presenting, null);
  if (!presenting) return null;
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  return (
    <div className="panel present-controls" role="toolbar" aria-label="Presentation">
      <button
        type="button"
        aria-label="Previous slide"
        title="Previous slide (←)"
        disabled={presenting.index === 0}
        onMouseDown={keepFocus}
        onClick={() => engine.presentStep(-1)}
        data-testid="present-prev"
      >
        ←
      </button>
      <span className="present-count" role="status" data-testid="present-count">
        {`Slide ${presenting.index + 1} of ${presenting.count}`}
      </span>
      <button
        type="button"
        aria-label="Next slide"
        title="Next slide (→)"
        disabled={presenting.index >= presenting.count - 1}
        onMouseDown={keepFocus}
        onClick={() => engine.presentStep(1)}
        data-testid="present-next"
      >
        →
      </button>
      <span className="divider" aria-hidden="true" />
      <button
        type="button"
        aria-label="Stop presenting"
        title="Stop presenting (Esc)"
        onMouseDown={keepFocus}
        onClick={() => engine.stopPresenting()}
        data-testid="present-stop"
      >
        Exit
      </button>
    </div>
  );
}
