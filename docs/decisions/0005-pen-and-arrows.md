# 0005: Strokes store whole-number points once; arrows store what they're attached to, not where

- Status: accepted
- Date: 2026-10-17
- Code: [`packages/engine/src/freehand.ts`](../../packages/engine/src/freehand.ts), [`packages/engine/src/arrows.ts`](../../packages/engine/src/arrows.ts), [`packages/engine/src/scene.ts`](../../packages/engine/src/scene.ts), [`packages/doc/src/shape.ts`](../../packages/doc/src/shape.ts)

## Decision

- **Freehand strokes are box shapes with points inside the box.** Each point is three whole numbers: across and down the box (0 to 10,000) and pressure (0 to 100), in one flat array. Points are written when the stroke is finished and never changed; moving, resizing and rotating change the box. Strokes are drawn as filled outlines from [perfect-freehand](https://github.com/steveruizok/perfect-freehand) 1.2 (MIT).
- **Arrows store `from` and `to`, the shapes their ends are attached to.** An attached end is placed when the arrow is drawn, on the line between the two ends where it leaves the shape. Moving a shape never writes to its arrows. The stored point of an attached end is only where it was last placed, used when the shape is gone.
- **Every edit to an arrow starts from where it's drawn,** and lets go of shapes that aren't moving with it. Deleting a shape writes its arrows' drawn positions in the same change, so they stay put.
- Board format version 3. Older versions of Niro open these boards read-only.

## Why

- Whole numbers make a 200-point stroke's update 1,744 bytes, against 5,434 for decimals and 8,436 for point objects (measured; [the write-up](../learning/pen-and-arrows.md#storing-points)). Writing points once makes a stroke one change and one undo step.
- Stored arrow ends would need rewriting on every frame of every drag of every attached shape, and a client that hadn't yet seen a move would write ends at the old position, which the CRDT would keep. Working ends out from the document means every client that has the same document draws the same arrows.

## What this gives up

- **Strokes appear to others when finished,** not as they're drawn. Showing strokes in progress would go through presence (not the document), later.
- **The engine's scene differs from the document for arrows.** Code that edits an arrow must use the drawn arrow (`asDrawn`), or ends jump; tests cover each gesture.
- **Arrows aim at centers.** Pinning an end to a chosen point on an outline would need a stored position relative to the shape (as tldraw's bindings do); `from`/`to` can grow into that.

## Alternatives considered

- **`Y.Array` of points, appended while drawing:** others would see strokes live, but one stroke would be hundreds of changes, and undo would need grouping. The finished stroke is about the same size either way (1,751 bytes, measured with one push).
- **SVG-path strings for strokes:** compact, but parsing on every read and no pressure.
- **A separate "bindings" collection** (tldraw's model): more general (any shape to any shape, with anchor points), and the right step if arrows grow elbows and labels. For straight arrows aimed at centers, two fields on the arrow do the same with less machinery.
