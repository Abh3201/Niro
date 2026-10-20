# 0009: A pen stroke that starts on a sticky note belongs to the note

- Status: accepted
- Date: 2026-10-20
- Code: [`packages/engine/src/structure.ts`](../../packages/engine/src/structure.ts) (`inkHostAt`, `placeInk`, `movers`, `reparentOnMove`), [`packages/engine/src/interaction.ts`](../../packages/engine/src/interaction.ts), [`packages/doc/src/shape.ts`](../../packages/doc/src/shape.ts)

## Decision

- **Where the stroke starts decides.** The topmost shape under the pen when the stroke begins (other strokes aside) is the owner if it's an unlocked sticky note: the stroke gets that note as its `parentId`, drawn just above the note's other ink. Anywhere else, it behaves as before: on the board, or in the frame it starts in.
- **Alt held as the stroke starts puts it on the board.** While the pen tool is active, the note the next stroke would belong to is outlined, before and during the stroke, so the choice is visible before ink is down. Only the start matters: releasing Alt mid-stroke changes nothing.
- **A stroke that runs past the note's edge is kept whole, not clipped.** Clipping would hide ink with no way to get it back; frames clip because they're a deliberate surface, a note is not.
- **Sticky notes join groups and frames as shapes that can be a `parentId`** (`isContainer`), but only pen strokes are ever put in one. Ink keeps its board position, like a group's members (decision 0006): moving, nudging, rotating or resizing a note writes the note and its ink together (`movers`, `withDescendants`). Resizing a note leaves ink where it is. Inside a frame, ink is stored from the frame's corner as any frame member is.
- **Dragging a stroke by itself follows its center**: dropped on another note, it joins it; dropped off any note, it goes to the board or the frame under it; nudged within its note, it stays.
- Copy, duplicate, delete, lock and export treat ink as part of the note through `withDescendants`; Tab reaches ink through its note in reading order.
- Board format version 7. Strokes drawn before stay on the board; nothing is migrated, because "which note was it meant for" can't be told from the data.

## Why

- **It matches what people mean**: ink written on a note is the note's, and ink scribbled around it is the board's. Deciding at the start is predictable (the outline shows it) and needs no second pass.
- **Reuse over a new concept.** The parent tree, its cycle repair, copy and delete already exist; the only new rules are who may be a parent and who moves with whom.
- **Board positions, not note-relative positions.** Notes rotate, frames don't; storing ink in a rotating note's own space would need rotation math in every reader and in `board-tx.ts`. The cost is the one groups already carry: moving a note writes each stroke on it, and two people moving the same note and editing its ink at once can leave a stroke behind. Notes carry a few strokes, not the 50 shapes that made decision 0006 choose frame-relative storage.

## What this gives up

- **Ink is drawn right after its note**, so a shape above the note in z-order but overlapping it is drawn under the ink.
- **Older clients** (schema 6) don't treat a note as a parent: the ink shows in the right place but doesn't follow the note, so they are held read-only after the version bump, as with earlier format changes.
- **Rectangles, ellipses and images aren't hosts.** A big rectangle used as a background would capture every doodle on it; add it when a use for it shows up.

## Alternatives considered

- **Group the ink and the note automatically.** Simple, but the note then selects as a group, ink included, which gets in the way of editing the note's text and recoloring it.
- **Positions relative to the note** (as frames): one write per move, but rotation math and a bigger migration, for the few strokes a note holds.
- **A toolbar toggle** instead of Alt: always visible, but one more thing to set. The outline shows the outcome before the stroke, and Alt is already the "turn off the automatic thing" key for snapping.
