import { COLORS, type ColorName } from "@niro/doc";
import { DARK_PALETTE, type Engine, LIGHT_PALETTE } from "@niro/engine";
import {
  BringForwardIcon,
  BringToFrontIcon,
  DuplicateIcon,
  SendBackwardIcon,
  SendToBackIcon,
  TrashIcon,
} from "./icons";
import { useEngineState } from "./useEngineState";
import { usePrefersDark } from "./usePrefersDark";

const NO_SELECTION: readonly string[] = [];

/** Color, order, duplicate and delete for the selected shapes. Hidden when nothing is selected. */
export function SelectionPanel({ engine }: { engine: Engine }) {
  const selection = useEngineState(engine, (s) => s.selection, NO_SELECTION);
  const color = useEngineState(engine, (s) => s.selectionColor, null);
  const readOnly = useEngineState(engine, (s) => s.readOnly, false);
  // Swatches show each color the way the board draws it in this theme.
  const palette = usePrefersDark() ? DARK_PALETTE : LIGHT_PALETTE;
  if (selection.length === 0 || readOnly) return null;

  return (
    <div className="panel selection-panel" role="toolbar" aria-label="Selection">
      <fieldset className="swatches">
        <legend className="visually-hidden">Color</legend>
        {COLORS.map((name: ColorName) => (
          <button
            key={name}
            type="button"
            aria-pressed={color === name}
            aria-label={name}
            title={name}
            data-testid={`color-${name}`}
            className="swatch"
            style={{ background: palette.solid[name] }}
            onClick={() => engine.setSelectionColor(name)}
          />
        ))}
      </fieldset>
      <span className="divider" />
      <button
        type="button"
        aria-label="Bring to front"
        title="Bring to front (Shift ])"
        data-testid="bring-to-front"
        onClick={() => engine.reorderSelection("front")}
      >
        <BringToFrontIcon />
      </button>
      <button
        type="button"
        aria-label="Bring forward"
        title="Bring forward (])"
        onClick={() => engine.reorderSelection("forward")}
      >
        <BringForwardIcon />
      </button>
      <button
        type="button"
        aria-label="Send backward"
        title="Send backward ([)"
        onClick={() => engine.reorderSelection("backward")}
      >
        <SendBackwardIcon />
      </button>
      <button
        type="button"
        aria-label="Send to back"
        title="Send to back (Shift [)"
        data-testid="send-to-back"
        onClick={() => engine.reorderSelection("back")}
      >
        <SendToBackIcon />
      </button>
      <span className="divider" />
      <button
        type="button"
        aria-label="Duplicate"
        title="Duplicate (Ctrl D)"
        data-testid="duplicate"
        onClick={engine.duplicateSelection}
      >
        <DuplicateIcon />
      </button>
      <button
        type="button"
        aria-label="Delete"
        title="Delete (Del)"
        data-testid="delete"
        onClick={engine.deleteSelection}
      >
        <TrashIcon />
      </button>
    </div>
  );
}
