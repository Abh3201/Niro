import {
  ALIGNS,
  COLORS,
  type ColorName,
  DASHES,
  FONTS,
  type FontName,
  type FontSize,
  HEADS,
  REACTION_NAMES,
  REACTIONS,
  ROUTES,
  THICKNESSES,
  VALIGNS,
} from "@niro/doc";
import {
  DARK_PALETTE,
  type Engine,
  FONT_FAMILIES,
  LIGHT_PALETTE,
  type Palette,
  type ReactionSummary,
  type TextStyle,
} from "@niro/engine";
import type { MouseEvent } from "react";
import {
  AlignIcon,
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
  VerticalAlignIcon,
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
  const text = useEngineState(engine, (s) => s.selectionText, null);
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
      {text && <TextPanel engine={engine} text={text} palette={palette} />}
    </>
  );
}

const FONT_LABELS: Record<FontName, string> = {
  sans: "Sans",
  serif: "Serif",
  mono: "Mono",
  hand: "Hand",
};
/** Sizes offered, in world units; any other size set elsewhere is offered too. */
const FONT_SIZES = [12, 16, 20, 24, 32, 48, 64, 96, 128];

/** Keeps the text editor open when a button is pressed while typing: the change is for the shape being edited. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * Font, size, bold, italic, underline, strikethrough, alignment and text
 * color for the selected shapes' text. Each applies to all of a shape's
 * text, not to selected words.
 */
function TextPanel({
  engine,
  text,
  palette,
}: {
  engine: Engine;
  text: TextStyle;
  palette: Palette;
}) {
  const sizes =
    typeof text.fontSize === "number" && !FONT_SIZES.includes(text.fontSize)
      ? [...FONT_SIZES, text.fontSize].sort((a, b) => a - b)
      : FONT_SIZES;
  const toggles = [
    { style: "bold", label: "Bold", key: "Ctrl B", glyph: <b>B</b> },
    { style: "italic", label: "Italic", key: "Ctrl I", glyph: <i>I</i> },
    { style: "underline", label: "Underline", key: "Ctrl U", glyph: <u>U</u> },
    { style: "strike", label: "Strikethrough", key: "", glyph: <s>S</s> },
  ] as const;
  return (
    <div className="panel selection-panel text-panel" role="toolbar" aria-label="Text">
      <select
        aria-label="Font"
        title="Font"
        data-testid="text-font"
        value={text.font ?? ""}
        onChange={(event) => engine.setTextStyle({ font: event.target.value as FontName })}
      >
        {text.font === null && (
          <option value="" disabled>
            Mixed
          </option>
        )}
        {FONTS.map((font) => (
          <option key={font} value={font} style={{ fontFamily: FONT_FAMILIES[font] }}>
            {FONT_LABELS[font]}
          </option>
        ))}
      </select>
      <select
        aria-label="Font size"
        title="Font size (in a shape, the largest: longer text still shrinks to fit)"
        data-testid="text-size"
        value={text.fontSize === null ? "" : String(text.fontSize)}
        onChange={(event) => {
          const value = event.target.value;
          const fontSize: FontSize = value === "auto" ? "auto" : Number(value);
          engine.setTextStyle({ fontSize });
        }}
      >
        {text.fontSize === null && (
          <option value="" disabled>
            Mixed
          </option>
        )}
        <option value="auto">Auto</option>
        {sizes.map((size) => (
          <option key={size} value={String(size)}>
            {size}
          </option>
        ))}
      </select>
      <span className="divider" />
      {toggles.map(({ style, label, key, glyph }) => (
        <button
          key={style}
          type="button"
          aria-pressed={text[style] === true}
          aria-label={label}
          title={key ? `${label} (${key})` : label}
          data-testid={`text-${style}`}
          className="text-toggle"
          onMouseDown={keepFocus}
          onClick={() => engine.toggleTextStyle(style)}
        >
          {glyph}
        </button>
      ))}
      <span className="divider" />
      {ALIGNS.map((align) => (
        <button
          key={align}
          type="button"
          aria-pressed={text.align === align}
          aria-label={`Align ${align}`}
          title={`Align ${align}`}
          data-testid={`text-align-${align}`}
          onMouseDown={keepFocus}
          onClick={() => engine.setTextStyle({ align })}
        >
          <AlignIcon align={align} />
        </button>
      ))}
      {text.boxes && (
        <>
          <span className="divider" />
          {VALIGNS.map((valign) => (
            <button
              key={valign}
              type="button"
              aria-pressed={text.valign === valign}
              aria-label={`Text at ${valign}`}
              title={`Text at the ${valign}`}
              data-testid={`text-valign-${valign}`}
              onMouseDown={keepFocus}
              onClick={() => engine.setTextStyle({ valign })}
            >
              <VerticalAlignIcon valign={valign} />
            </button>
          ))}
        </>
      )}
      <span className="divider" />
      <fieldset className="swatches">
        <legend className="visually-hidden">Text color</legend>
        {text.boxes && (
          <button
            type="button"
            aria-pressed={text.textColor === "auto"}
            aria-label="Text color: automatic"
            title="Text color: automatic"
            data-testid="text-color-auto"
            className="swatch swatch-auto"
            onMouseDown={keepFocus}
            onClick={() => engine.setTextStyle({ textColor: "auto" })}
          >
            A
          </button>
        )}
        {COLORS.map((name: ColorName) => (
          <button
            key={name}
            type="button"
            aria-pressed={text.textColor === name}
            aria-label={`Text color: ${name}`}
            title={`Text color: ${name}`}
            data-testid={`text-color-${name}`}
            className="swatch"
            style={{ background: palette.solid[name] }}
            onMouseDown={keepFocus}
            onClick={() => engine.setTextStyle({ textColor: name })}
          />
        ))}
      </fieldset>
    </div>
  );
}
