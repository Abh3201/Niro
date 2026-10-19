# How the pen and arrows work in Niro (P4b)

The pen is about input and storage: catching every point a fast pen passes through, and storing thousands of them cheaply in a CRDT. Arrows are about a choice that shapes everything else: whether an arrow's attached ends are stored or worked out. The code is in [`packages/engine/src/freehand.ts`](../../packages/engine/src/freehand.ts) and [`arrows.ts`](../../packages/engine/src/arrows.ts), with the gestures in [`interaction.ts`](../../packages/engine/src/interaction.ts) and the drawn arrows in [`scene.ts`](../../packages/engine/src/scene.ts).

## The pen

### Catching every point

Browsers send at most one `pointermove` per frame, 60 a second on most screens. A pen tablet or an iPad Pencil samples at 120 to 240 Hz, so most of its points never arrive as events: they're merged into the next one. `PointerEvent.getCoalescedEvents()` gives them back. Each move during a stroke takes all of them, so a fast curve stays round instead of turning into a polygon.

Pressure comes from `PointerEvent.pressure`, but only a pen means it: a mouse reports 0.5 while a button is down, and touch screens report whatever they like. Niro reads pressure from pens and uses 0.5 for everything else.

### Drawing a stroke as a filled outline

A canvas line has one width. A pen line should swell where it's pressed and taper at the ends, so a stroke isn't drawn as a line at all: [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT) turns the points into the *outline* of the stroke, a polygon, and that's filled. Without real pressure (all points at 0.5), it simulates some from speed: fast movement thins the line, as ink does.

The outline is smoothed by drawing quadratic curves through the midpoints of its edges, then cached as a `Path2D` per stroke and size. Building an outline costs about as much as drawing it, so a board of strokes would otherwise do it twice every frame.

While a stroke is being drawn it lives only in the overlay canvas, and goes into the document once, when the pen lifts. One stroke is one change, one undo step and one network message, rather than hundreds.

### Storing points

A stroke stores its points relative to its box: across and down from 0 to 10,000, with pressure from 0 to 100. Moving, resizing or rotating a stroke changes its box, never its points, so points are written once and never again.

Whole numbers matter in a CRDT update. Yjs writes a whole number as a small variable-length integer, and any other number as an 8-byte float. Measured for one 200-point stroke:

| Points stored as | Update size |
|---|---|
| `{ x, y, pressure }` objects, decimals | 8,436 bytes |
| flat array, decimals | 5,434 bytes |
| flat array, whole numbers (Niro) | 1,744 bytes |

That's about 9 bytes a point, 4.8 times less than the obvious format. The precision lost is 1/10,000 of the box: under a pixel on any stroke under 10,000 pixels across.

### Hitting a stroke

A click selects a stroke on its ink, not anywhere in its box: the point is turned into the stroke's own frame, then checked against each segment between its points, at half the pen's width plus the usual tolerance.

## Arrows

### The choice: store the ends, or work them out

An arrow from A to B has to follow A and B when they move. There are two ways to do that:

1. **Store where the ends are, and rewrite them** whenever A or B moves. Every frame of a drag then writes the shape and every arrow attached to it. Worse, it's wrong under concurrency: if Alice moves A while Bob, who hasn't seen the move yet, drags the arrow's other end, Bob's client writes the arrow's start where A *was*. The CRDT keeps the latest write, so the arrow points at empty space on everyone's screen.
2. **Store only what the arrow is attached to, and work out the ends when drawing.** The arrow stores `from: A, to: B`. Each client places the ends from where A and B are in its own copy of the document. Moving A never writes to the arrow, and since every client has the same document after syncing, every client draws the same arrow. Nothing can conflict, because there is nothing to conflict over.

Niro does the second. The cost is that the `Scene` (the engine's read model) holds arrows *as drawn*, different from what the document stores, and must place an arrow again whenever a shape it's attached to changes. It keeps an index from each shape to the arrows attached to it, so that's a lookup, not a scan.

### Where an attached end goes

An attached end aims at its shape's center, and stops at the outline, plus an 8-unit gap so the arrowhead doesn't touch the shape. Finding the outline is one formula per shape, in the shape's own (unrotated) frame, for a unit direction `(x, y)` from the center:

- a box `w × h`: `min((w/2) / |x|, (h/2) / |y|)`, whichever side the ray reaches first;
- an ellipse with radii `a`, `b`: `1 / √((x/a)² + (y/b)²)`.

When two shapes overlap, there's no room between their outlines, and the arrow runs center to center instead.

### Editing an arrow that isn't where it's stored

Because an attached end isn't stored where it's drawn, every edit has to start from the drawn arrow. The unit tests caught this: dragging the free end of an arrow attached at its start used the stored start and the new end, so the line jumped, and moving an arrow with one end attached threw its free end sideways. Now every change to an arrow's geometry writes the arrow as drawn first, then the change.

The rules for what stays attached:

- Creating an arrow attaches the end you start on and the end you drop on, if either is on a shape.
- Dragging an end attaches it to the shape you drop it on, or lets go if you drop it on empty space.
- Moving, resizing or rotating an arrow keeps the ends whose shapes move with it, and lets go of the others: you're putting the arrow somewhere else.
- Deleting a shape leaves its arrows where they're drawn (and undoing the delete attaches them again). Duplicating an arrow with its shapes attaches the copy to the copies.

## What's not there yet

- Arrows are straight, aim at centers, and have one kind of head. No elbows, curves, labels, or ends pinned to a point on the outline.
- Other people see a stroke when it's finished, not while it's drawn.
- No eraser: select a stroke and delete it.
- Resizing a stroke past its opposite side doesn't mirror it.
- New strokes and arrows are black; recolor them after drawing.
