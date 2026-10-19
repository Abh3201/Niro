# 0006: Shapes in a frame are stored where they are in the frame; groups have no geometry

- Status: accepted
- Date: 2026-10-17
- Code: [`packages/engine/src/board-tx.ts`](../../packages/engine/src/board-tx.ts), [`packages/engine/src/scene.ts`](../../packages/engine/src/scene.ts), [`packages/engine/src/structure.ts`](../../packages/engine/src/structure.ts), [`packages/doc/src/shape.ts`](../../packages/doc/src/shape.ts), [`packages/doc/src/tree.ts`](../../packages/doc/src/tree.ts)

## Decision

- **Two container types, `group` and `frame`,** hold shapes through `parentId` (the tree from decision 0001, with its cycle repair). Only they can hold shapes: a `parentId` pointing at anything else is read as top level.
- **A shape in a frame stores `(x, y)` from the frame's top-left.** Every reader adds the frame's position back when drawing (the engine's `Scene`). Engine code works in board coordinates throughout, and writes through one function, `transact` in `board-tx.ts`, which turns board positions into stored ones.
- **A group stores no geometry.** Its box is worked out from what's in it. Moving or scaling a group writes each shape in it.
- **Frames are upright boxes with a name above them.** They clip what's in them, are picked by the name or the edge (their inside is like the board: a drag there starts a marquee), and are drawn under what's in them.
- **Membership follows position.** A shape drawn or dropped with its center in a frame joins it (lines and arrows need both ends in it); dragged out, it leaves. A new frame takes in the shapes it's drawn fully around; a resized frame lets go of shapes left fully outside and takes in those now fully inside. Groups keep their members wherever they're dragged.
- Board format version 4. Boards from before have no containers, so their positions read the same.

## Why

- **Moving a frame is one write, not one per shape in it.** That matters twice:
  - *Concurrency.* With board positions stored, moving a frame writes every shape in it. Someone editing one of those shapes at the same time writes the same fields, and the CRDT keeps one write per field: the shape can end up with Alice's `x` and Bob's `y`, or left behind outside the frame, where the frame cuts it off and it can't be seen. With positions in the frame, the frame's move and the shape's edit touch different fields of different shapes, and both survive. It's the rule from decision 0005 again: store what a thing is attached to, not the result.
  - *Size.* Dragging a frame with 50 sticky notes for 60 frames: 2,065 bytes of updates stored this way, against 104,484 with board positions, and a document that grows by 2 KB instead of 102 KB (measured with Yjs 13.6.33; [the write-up](../learning/groups-and-frames.md#how-a-frame-move-is-stored)).
- **One conversion point.** The alternative, every gesture working out stored positions itself, would put coordinate maths in a dozen places. `board-tx.ts` collects a transaction's edits and converts them at the end, so it sees where each frame ends up before placing what's in it: scaling a group that holds a frame and its contents in one edit comes out right.
- **Groups without geometry can't disagree with their contents.** A stored group box would need rewriting whenever anything in it moved, from any client.

## What this gives up

- **A shape added to a frame that someone else deletes at the same moment** keeps its position from the frame, now read from the board's origin: it appears somewhere else. With board positions it would stay put. Deleting a frame while someone is adding to it is rarer than moving one while someone is editing in it.
- **A cycle repaired** (two people put two frames inside each other at once) makes one frame top level, and its position, stored from the other frame, jumps the same way.
- **Readers must place shapes before using them.** Anything reading the document directly (an export, a server-side renderer) has to add frame positions, as the `Scene` does.
- **Membership is decided by the client that moves a shape**, from where frames are on its screen; two people dragging the same shape at once can disagree, and the last write wins.

## Alternatives considered

- **Board positions for everything** (the first version of this milestone): simplest to read, and how Excalidraw stores frames. Rejected for the concurrency and size reasons above, found by measuring and by working through two people editing one frame.
- **Positions relative to any parent, groups included** (tldraw's model): groups would need stored geometry, which has to be kept in step with their contents by whoever edits them, the problem this avoids.
- **Loro's movable tree** (decision 0001): moves can't make cycles, but positions are still the app's to store; the same choice comes up.
