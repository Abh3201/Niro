# How text works in Niro (P4a)

Text looks like the simplest feature on a whiteboard and touches every layer: the canvas can't lay it out, the browser can't draw it on a canvas, and the CRDT has to merge two people typing in the same sticky note. The code is in [`packages/engine/src/text.ts`](../../packages/engine/src/text.ts) (layout), [`text-editor.ts`](../../packages/engine/src/text-editor.ts) (editing) and [`text-diff.ts`](../../packages/engine/src/text-diff.ts), and in [`packages/doc/src/yjs.ts`](../../packages/doc/src/yjs.ts) (storage).

## Drawing: the canvas has no text layout

`ctx.fillText("hello", x, y)` draws one line at one point. It doesn't wrap, and it doesn't know about boxes. So Niro breaks lines itself, by measuring:

1. Split at newlines, then at spaces. Add words to a line while it fits; a word that doesn't fit starts the next line. A word too long for any line breaks between characters (never inside an emoji: that's two UTF-16 code units, a *surrogate pair*, and half of one is garbage).
2. Spaces after the last word of a line *hang*: they don't push the line over. That's what browsers do with `white-space: pre-wrap`, and the editor (below) is a browser text field, so the two must agree.

Sticky notes, rectangles and ellipses shrink their text to fit: try the largest size, and if the wrapped lines are too tall, binary-search the size (12 steps). That's 13 layouts per keystroke, each measuring every word. It's cheap because **width scales linearly with font size**: each string is measured once with `measureText` at a 100px reference size, cached, and every other size is a multiplication.

Where the baseline goes matters more than it sounds. The browser centers each line's *content area* (the font's ascent plus descent) in a line box 1.25 times the font size tall; the canvas has to put its baseline in the same place, or text jumps by a pixel or two when editing ends. `TextMetrics.fontBoundingBoxAscent` and `Descent` give the font's real values, so the canvas computes the same position the browser would.

When text would be under 4 pixels tall on screen, it's drawn as faint bars instead: unreadable anyway, and a rectangle is far cheaper than glyphs.

## Editing: a real text field over the canvas

A canvas can't edit text: no cursor, no selection, no spell check, no input methods for Chinese or Japanese, nothing for screen readers. Rebuilding those is years of work. So while a shape is being edited, a transparent `<textarea>` sits exactly over its text, in the same font, size and wrap width, and the canvas skips that shape's text. The browser does the rest.

"Exactly over" includes rotation. The textarea is positioned with one CSS `matrix(cos, sin, -sin, cos, e, f)`: the shape's rotation, plus a translation to where the text's top-left corner lands on screen (the shape's center, plus the corner's offset in the shape's own frame, rotated). The font size is the world size times the zoom, so the text is crisp at any zoom instead of a scaled bitmap.

## Typing into a CRDT

Each shape's text is a `Y.Text`, so two people typing in one shape merge character by character. Two details:

- **The `Y.Text` is created with the shape**, even empty. If it were created on the first keystroke, two people starting to type at the same moment would each create one, and a map key holds one value: one person's text would vanish.
- **A textarea reports its new value, not the keystroke.** The editor compares the old and new values to recover the edit: keep the common start and end, replace the middle. That's ambiguous: typing "a" into "aa" gives "aaa" whichever "a" was typed. The cursor position after the change settles it: the edit ends where the cursor is. For one person this doesn't matter (the text looks the same either way), but with two it decides whose characters come first.

### Keeping your cursor while someone else types

When someone else's typing arrives, the textarea's value is replaced, and your cursor has to move with the characters it was between. The first version worked that out the same way, by comparing old and new text. The end-to-end test, two browsers typing "hello from alice" and "hello from bob" into one sticky at the same moment, failed 7 times out of 8:

```
hhello from bobello from alice
```

Both typed "h" first. When Bob's "h" arrived next to Alice's, comparing "h" with "hh" can't tell whose is whose, so Alice's cursor sometimes jumped past Bob's, and her next letters went into his word.

The fix is to stop guessing. Yjs knows exactly what changed: its text events carry a *delta* (retain 3, insert "x", delete 2). The store passes that along with each change (`ShapeChange.textEdits`), and the editor moves the cursor through those exact edits. The same test then passed 15 times out of 15. Comparing texts is still there as a fallback, for stores that can't say.

### Input methods

Typing Japanese, Chinese or accented letters goes through a *composition*: the text changes in place ("に", "にほ") until it's committed ("日本"). Writing those intermediate states into the document would send half-words to everyone, and replacing the textarea's value mid-composition (because someone else typed) cancels the composition. So during a composition the editor leaves the textarea alone, both ways. When it's committed, the edit is moved past anything others typed meanwhile (`rebaseEdit`), written, and the textarea catches up.

## Text shapes grow with their text

A text shape wraps at its width and is as tall as its lines. Its height is stored, so hit testing and selection work on every client without measuring, and it's rewritten with each keystroke and resize. A rotated text shape grows along its own axis, not straight down: changing the height moves the center by half the change along the shape's own y axis, `(-sin θ, cos θ)`, which keeps the top edge where it was.

## What's not there yet

- One font and one size for text shapes; no bold, lists or links. Text is plain, which keeps the CRDT simple.
- The canvas and the browser can still wrap a line differently in rare cases (the canvas measures at 100px and scales; the browser lays out at the real size), so text can shift slightly when editing ends.
- Every visible shape's text is redrawn on every frame something moves. P5 adds culling and caching.
