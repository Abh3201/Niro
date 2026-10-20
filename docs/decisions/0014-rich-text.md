# 0014: Formatting on parts of a shape's text, stored as Y.Text attributes; Hand (Kalam) for new text

- Status: accepted
- Date: 2026-10-20
- Code: [`packages/doc/src/text-runs.ts`](../../packages/doc/src/text-runs.ts), [`packages/doc/src/yjs.ts`](../../packages/doc/src/yjs.ts) (`formatText`, `runsOf`, `applyRuns`), [`packages/engine/src/text.ts`](../../packages/engine/src/text.ts) (`layoutText`, `styledParagraphs`), [`packages/engine/src/render.ts`](../../packages/engine/src/render.ts) (`drawText`), [`packages/engine/src/text-editor.ts`](../../packages/engine/src/text-editor.ts), [`packages/engine/src/rich-text.ts`](../../packages/engine/src/rich-text.ts)

## Context

Decision 0013 made formatting per shape. People write a heading and a body in one note, and expect underlining the heading to leave the body alone, and the line after the heading to start in the heading's style.

## Decision

- **Marks on characters, over the shape's settings.** A range of a shape's text can carry `bold`, `italic`, `underline`, `strike`, `font`, `size` and `color`; where absent, the shape's 0013 field applies. `false` is a value (one plain word in a bold note). Marks are Yjs formatting attributes on the shape's `Y.Text`, so they sync, merge and undo with the text, and two people formatting different words both keep theirs. `readShape` turns them into `Shape.textRuns` (runs covering the whole text, validated, none when nothing is formatted), and `DocStore` gains `formatText` and a `marks` argument to `editText`.
- **Alignment is per paragraph, stored on the line break that ends it**; the last paragraph, which has none, uses `Shape.align`. Aligning the last paragraph while others follow the shape stamps the old alignment on those first, so nothing else moves.
- **Typing takes the formatting of the character before**, so a new line carries on in the heading's style; at the start of a line, of its first character; on an empty line, of the line break that holds its style. With nothing selected, formatting is held for what's typed next, as in word processors; on an empty line it applies at once, so the line shows it. Formatting a shape while it's selected, not being edited, sets the shape's field and takes that mark off all its text.
- **The editor is an editable `<div>`**, a block per paragraph and a span per run, drawn again from the document after every change. Typing, line breaks and pastes are taken from `beforeinput` and written with their marks; anything the browser does itself (deleting words, input methods) is read back and diffed, as with the textarea before. Content is set with its smallest letters at 100px and scaled, so it wraps where the canvas does.
- **Layout is per piece**: lines break by the widths of each run at its own size; a line is as tall as its biggest piece, with each font's content area centered in its line height, as CSS does. A box's text shrinks every size by one factor until it fits.
- **Hand is Kalam, served with the app** (`@fontsource/kalam`, SIL Open Font License 1.1, regular and bold; each script's file, Latin, Latin Extended or Devanagari, is fetched only when text needs it), and new notes, shapes and text start in it. Existing shapes keep what they had (no `font` means sans). When fonts finish loading, every measurement and layout is dropped and redone, which answers 0013's objection to web fonts.
- **Board format version 10**, no data migration: a board without marks draws as before, and version 9 clients open newer boards read-only.

## Why

- Yjs formatting attributes are the format's own answer for rich text: no second structure to keep in step with the characters, and CRDT merging of concurrent formatting for free.
- Keeping Niro's own layout (rather than ProseMirror's DOM) keeps canvas drawing, exports, the fit-to-box search and the layout cache working.

## What this gives up

- **No drag and drop of text inside the editor**, and pasted text is plain.
- **A paragraph split by Enter keeps its alignment; two joined by deleting the break take the second's.**
- **SVG exports name Kalam but don't embed it**: an SVG viewer without the font shows Comic Sans or `cursive`. PNG exports are drawn with it.
- **Shapes with formatted parts lay out again when anything about them changes** (their runs are compared as text in the cache key), and the editor's content is drawn again on every keystroke; fine for notes, slower for a 10,000-character text.
- **Formatting with only the caret in a word doesn't format the word**, unlike Word; select it first.

## Alternatives considered

- **ProseMirror with `y-prosemirror`**: a complete editor, but a second document model per shape, and the canvas would still need its own layout of the same text.
- **Per-line style fields instead of marks**: simpler, but "bold one word" would stay impossible and lines that wrap aren't lines the user chose.
- **Patrick Hand or Caveat**: also OFL; Kalam has a real bold and reads well small.
