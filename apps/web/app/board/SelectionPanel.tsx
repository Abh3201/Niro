import {
  COLORS,
  type ColorName,
  DASHES,
  HEADS,
  REACTION_NAMES,
  REACTIONS,
  ROUTES,
  THICKNESSES,
} from "@niro/doc";
import { DARK_PALETTE, type Engine, LIGHT_PALETTE, type ReactionSummary } from "@niro/engine";
import {
  BringForwardIcon,
  BringToFrontIcon,
  DuplicateIcon,
  GroupIcon,
  HeadSampleIcon,
  LockIcon,
  RouteSampleIcon,
  SendBackwardIcon,
  SendToBackIcon,
  StrokeSampleIcon,
  TrashIcon,
  UngroupIcon,
  UnlockIcon,
} from "./icons";
import { useDarkTheme } from "./theme";
import { useEngineState } from "./useEngineState";

const NO_SELECTION: readonly string[] = [];
const NO_REACTIONS: readonly ReactionSummary[] = [];

/**
 * Color, order, grouping, duplicate and delete for the selected shapes.
 * Hidden when nothing is selected.
 */
export function SelectionPanel({ engine }: { engine: Engine }) {
  const selection = useEngineState(engine, (s) => s.selection, NO_SELECTION);
  const color = useEngineState(engine, (s) => s.selectionColor, null);
  const canGroup = useEngineState(engine, (s) => s.canGroup, false);
  const canUngroup = useEngineState(engine, (s) => s.canUngroup, false);
  const readOnly = useEngineState(engine, (s) => s.readOnly, false);
  const reactions = useEngineState(engine, (s) => s.selectionReactions, NO_REACTIONS);
  const locked = useEngineState(engine, (s) => s.selectionLocked, false);
  const line = useEngineState(engine, (s) => s.selectionLine, null);
  // Swatches show each color the way the board draws it in this theme.
  const palette = useDarkTheme() ? DARK_PALETTE : LIGHT_PALETTE;
  if (selection.length === 0 || readOnly) return null;

  const reactionButtons = (
    <fieldset className="reactions">
      <legend className="visually-hidden">Reactions</legend>
      {REACTION_NAMES.map((name) => {
        const summary = reactions.find((r) => r.reaction === name);
        return (
          <button
            key={name}
            type="button"
            aria-pressed={summary?.mine ?? false}
            aria-label={`React ${name}${summary ? `, ${summary.count}` : ""}`}
            title={`React ${name}`}
            data-testid={`react-${name}`}
            className="reaction"
            onClick={() => engine.toggleReaction(name)}
          >
            <span aria-hidden="true">{REACTIONS[name]}</span>
            {summary && <span className="reaction-count">{summary.count}</span>}
          </button>
        );
      })}
    </fieldset>
  );

  // Locked shapes can be unlocked, copied and reacted to; nothing else changes them.
  if (locked)
    return (
      <div className="panel selection-panel" role="toolbar" aria-label="Selection (locked)">
        <button
          type="button"
          aria-label="Unlock"
          title="Unlock (Shift Alt L)"
          data-testid="unlock"
          onClick={engine.toggleLock}
        >
          <UnlockIcon />
        </button>
        <span className="divider" />
        {reactionButtons}
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
      </div>
    );

  return (
    <>
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
        {(canGroup || canUngroup) && <span className="divider" />}
        {canGroup && (
          <button
            type="button"
            aria-label="Group"
            title="Group (Ctrl G)"
            data-testid="group"
            onClick={engine.groupSelection}
          >
            <GroupIcon />
          </button>
        )}
        {canUngroup && (
          <button
            type="button"
            aria-label="Ungroup"
            title="Ungroup (Ctrl Shift G)"
            data-testid="ungroup"
            onClick={engine.ungroupSelection}
          >
            <UngroupIcon />
          </button>
        )}
        <span className="divider" />
        <span className="divider" />
        {reactionButtons}
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
          aria-label="Lock"
          title="Lock (Shift Alt L)"
          data-testid="lock"
          onClick={engine.toggleLock}
        >
          <LockIcon />
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
      {line && (
        <div className="panel selection-panel line-panel" role="toolbar" aria-label="Line style">
          <fieldset className="line-style">
            <legend className="visually-hidden">Line style</legend>
            {DASHES.map((dash) => (
              <button
                key={dash}
                type="button"
                aria-pressed={line.dash === dash}
                aria-label={dash}
                title={`Line: ${dash}`}
                data-testid={`dash-${dash}`}
                onClick={() => engine.setLineStyle({ dash })}
              >
                <StrokeSampleIcon dash={dash === "solid" ? undefined : dash} />
              </button>
            ))}
            <span className="divider" />
            {THICKNESSES.map((thickness, i) => (
              <button
                key={thickness}
                type="button"
                aria-pressed={line.thickness === thickness}
                aria-label={thickness}
                title={`Thickness: ${thickness}`}
                data-testid={`thickness-${thickness}`}
                onClick={() => engine.setLineStyle({ thickness })}
              >
                <StrokeSampleIcon width={[1, 2, 4][i]} />
              </button>
            ))}
            <span className="divider" />
            {line.routable && (
              <>
                <span className="divider" />
                {ROUTES.map((route) => (
                  <button
                    key={route}
                    type="button"
                    aria-pressed={line.route === route}
                    aria-label={`${route} arrow`}
                    title={route === "elbow" ? "Elbow: right angles around shapes" : "Straight"}
                    data-testid={`route-${route}`}
                    onClick={() => engine.setLineStyle({ route })}
                  >
                    <RouteSampleIcon route={route} />
                  </button>
                ))}
              </>
            )}
            <span className="divider" />
            {HEADS.map((head) => (
              <button
                key={head}
                type="button"
                aria-pressed={line.head === head}
                aria-label={`arrowheads: ${head}`}
                title={`Arrowheads: ${head === "none" ? "none" : head === "both" ? "both ends" : `${head} only`}`}
                data-testid={`head-${head}`}
                onClick={() => engine.setLineStyle({ head })}
              >
                <HeadSampleIcon head={head} />
              </button>
            ))}
          </fieldset>
        </div>
      )}
    </>
  );
}
