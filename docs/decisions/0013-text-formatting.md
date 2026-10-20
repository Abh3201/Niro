# 0013: Text formatting is per shape: one font, size, style, alignment and color for all of a shape's text

- Status: accepted
- Date: 2026-10-20
- Code: [`packages/doc/src/shape.ts`](../../packages/doc/src/shape.ts) (`takesTextStyle`, `readShape`), [`packages/engine/src/text.ts`](../../packages/engine/src/text.ts) (`cssFont`, `layoutText`, `canvasFontMetrics`), [`packages/engine/src/render.ts`](../../packages/engine/src/render.ts) (`drawText`), [`packages/engine/src/structure.ts`](../../packages/engine/src/structure.ts) (`sharedTextStyle`, `textStylePatch`), [`apps/web/app/board/SelectionPanel.tsx`](../../apps/web/app/board/SelectionPanel.tsx)

## Decision

- **Formatting belongs to the shape, not to characters.** Sticky notes, rectangles, ellipses and text shapes get nine optional fields: `font` (sans, serif, mono, hand), `fontSize`, `bold`, `italic`, `underline`, `strike`, `align` (left, center, right), `valign` (top, middle, bottom; boxes only) and `textColor` (boxes only; a text shape's text is its `color`). Each is stored only when it isn't the default, as plain values in the shape's map, so two people changing different fields (one makes it bold, one recolors it) both keep their change, and undo, copy and paste, duplicate and version history carry them like any other field. Frames' names stay unformatted.
- **Font size in a box is the largest size, not a promise.** Text in a note, rectangle or ellipse still shrinks to fit (decision 0004's search), starting from the size set instead of the automatic one. A text shape is set at exactly that size and its height refits, as it does when typing.
- **Only fonts already on people's computers.** Each name is a list (Georgia, then Times New Roman, then `serif`; Comic Sans MS, then Comic Neue, then `cursive`, and so on). No web font downloads: text is measured the moment it's drawn, and a font that arrives later would make every measured width wrong until each layout was redone. Exports need nothing embedded either.
- **Measured per font.** Widths are cached per CSS font (family, weight, style) and string, at the 100px reference size, and the baseline is worked out per font, because ascent and descent differ between families. Text is still drawn at 100px and scaled (decision 0004, the macOS fix in #21), and the squeeze backstop still applies. The editor's textarea is set in the same font, weight, style, decoration and alignment, so it wraps where the canvas does.
- **Underline and strikethrough are drawn as filled bars** under or through each line's measured width: canvas has no text decoration, and the same calls work in the SVG export context.
- **Text colors are names, like shape colors.** On sticky notes they're drawn with the light theme's values in both themes, because the paper is light in both; on rectangles and ellipses, with the current theme's.
- **Ctrl/⌘ + B, I, U** toggle bold, italic and underline for the selection, and for the shape being edited while typing (the editor stays open). Panel buttons don't take focus from the editor.
- **Board format version 9.** No data migration: an absent field means what boards drew before. Clients on version 8 open newer boards read-only, so they never draw formatted text wrongly while someone edits it.

## Why

- **It's what was asked for at a fraction of the cost.** The standard controls (font, size, B/I/U/S, alignment, color) cover what people format on a whiteboard, where a note is usually one thought in one style.
- **It keeps decision 0004's design.** Plain `Y.Text`, a textarea editor and Niro's own line breaking all stay; formatting adds fields, not a new text model.

## What this gives up

- **No rich text**: you can't bold one word in a note. That needs formatting attributes on the `Y.Text`, a `contentEditable` or ProseMirror editor (`y-prosemirror`), and a layout engine that measures runs of different fonts on one line. It's the natural next step, and these per-shape fields can become the defaults for a shape's runs.
- **A font looks different from one computer to another**: "hand" is Comic Sans on Windows and macOS but whatever `cursive` is on Linux, and line breaks follow the font each person has. Every client still fits text in its own shapes.
- **Mixed fonts on one board measure more strings**: the width cache is per font and string, so a board in four fonts can fill it four times faster. It's cleared at 20,000 entries as before.
- **New shapes start unformatted**: the last style used isn't remembered for the next note.

## Alternatives considered

- **Rich text now** (`Y.Text` attributes and ProseMirror): what Miro does, but a new editor, a new layout engine and a format change much bigger than this one; per-shape style was the asked-for default.
- **Web fonts** (a handwriting font like Excalidraw's): one look everywhere, but a download before first draw, a relayout when it lands, and fonts to embed in SVG exports.
- **Numeric sizes only, no "auto"**: simpler, but notes would stop shrinking text to fit, which is what makes them readable at any length.
