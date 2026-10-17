# How groups and frames work in Niro (P4c)

Groups and frames turn a flat list of shapes into a tree. That changes drawing (order, clipping), clicking (what a click selects), and, most of all, storage: where a shape in a frame keeps its position decides what happens when two people work on one frame at once. The code is in [`packages/engine/src/scene.ts`](../../packages/engine/src/scene.ts) (the tree, drawing order, hit testing), [`structure.ts`](../../packages/engine/src/structure.ts) (group, ungroup, delete, duplicate, joining and leaving frames) and [`board-tx.ts`](../../packages/engine/src/board-tx.ts) (stored positions).

## The tree

Each shape has a `parentId`: the group or frame it's in, or null. Yjs has no "move" operation, so two people can make moves that are each fine but together make a loop (A into B on one screen, B into A on another). Niro doesn't write a fix back, which two clients could do differently at once. Every reader works out the same *effective* parent from the same data: a parent that isn't a group or frame counts as none, and in a loop the shape with the smallest id goes to the top level ([decision 0001](../decisions/0001-sync-library.md), [`tree.ts`](../../packages/doc/src/tree.ts)).

## Drawing

Shapes are drawn depth first: a shape, then what's in it, siblings in `(index, id)` order. So everything in a frame is drawn over the frame, and the frame and its contents move up and down the stack as one.

A frame cuts off what's in it at its edges. Canvas has a tool for exactly this: `ctx.clip()` limits all later drawing to the current path, and successive clips intersect, so a shape in a frame in a frame is clipped to both. Clipping is state, saved and restored with `ctx.save()` / `ctx.restore()`, and changing it costs something, so the scene gives every shape in the same frames *the same array* of frames. The draw loop only touches the clip when that array changes, which is once per frame entered or left, not once per shape.

## Clicking

A frame is picked by its name or its edge. Its inside works like the board: a drag there starts a marquee, which selects what's in the frame rather than the frame (a marquee selects a frame only when it takes in the whole frame). But the inside still hides what's under it, so a click there can't pick a shape that the frame covers. Parts of shapes cut off at a frame's edge can't be clicked either: the scene checks the point is inside every frame the shape is in.

A click on a shape in a group selects the group (the outermost one, stopping at frames). A double click steps one level in and selects the shape there; from then on, clicks stay at that level, so the other shapes in the group can be picked one by one. That "level" isn't stored anywhere: it's read from the current selection (if something in group G is selected, clicks inside G pick G's shapes).

A group draws nothing and has no box of its own: the scene works out its box from what's in it every time one of those shapes moves, deepest groups first.

## Joining and leaving frames

Membership follows position, decided by the shape's center (both ends, for lines and arrows, so an arrow from inside a frame to outside isn't cut off at the edge):

- a new shape goes into the frame it's drawn in;
- a dragged shape joins the frame it's dropped in and leaves the one it's dragged out of, while it's being dragged, so it's clipped by the frame it's over;
- a new frame takes in the shapes it's drawn fully around, and a resized frame takes in or lets go of shapes fully inside or outside it.

Shapes in a group stay in their group however they're dragged: the group joins and leaves frames as a whole.

## How a frame move is stored

The first version of this milestone stored every position on the board, as it was before groups and frames existed. Moving a frame then meant writing the frame and every shape in it, on every frame of the drag. Two things are wrong with that.

**It loses edits.** Say Alice drags a frame while Bob drags a sticky note inside it. Alice's client writes the note's position as part of moving the frame; Bob's writes it as part of his drag. The CRDT keeps one write per field, so the note ends up with one person's `x` and maybe the other's `y`. Worse, if Bob had just added the note, Alice's client didn't know about it yet: the note stays where the frame was, outside it now, and the frame clips it out of sight.

**It's big.** Measured with Yjs 13.6.33, dragging a frame holding 50 notes for 60 frames:

| Positions stored | Update bytes for the drag | Document after |
|---|---|---|
| on the board | 104,484 | 114,502 |
| in the frame (Niro) | 2,065 | 12,084 |

Each overwritten value leaves a tombstone, so the document keeps the cost.

So a shape in a frame stores where it is *in the frame*: `(x, y)` from the frame's top-left. Moving a frame writes the frame alone; everything in it follows on every client, because every client adds the frame's position when it draws. Alice's move and Bob's drag now touch different shapes and both survive. It's the same idea as storing what an arrow is attached to rather than where its ends are ([pen and arrows](pen-and-arrows.md#the-choice-store-the-ends-or-work-them-out)).

The engine still thinks in board positions everywhere: dragging, scaling and rotating are all easier there. Every write goes through `transact` in `board-tx.ts`, which collects the edits of one transaction and only then converts them. Waiting matters: scaling a group that holds a frame and what's in it changes the frame and its contents in one edit, and each content's stored position must be measured from where the frame *ends up*, not where it was. The conversion works out where every shape will be (moved explicitly, kept in place while changing frames, or carried along by its frame), then subtracts its new frame's position. A property test throws random moves and frame changes at it and checks every shape lands where it was asked to go.

Groups don't get the same treatment: they have no geometry to measure from, so moving a group still writes each shape in it. That's fine: what's in a group only changes when someone groups or ungroups, which is rare.

## What it costs

- A shape added to a frame at the moment someone else deletes that frame keeps its in-frame position, now read from the board's origin, so it turns up somewhere else. With board positions, it would have stayed put.
- If two people put two frames inside each other at once, the loop is broken by making one top level, and that one jumps the same way.
- Anything that reads the document directly, like a future export, has to add frame positions back.

## What's not there yet

- Frames have no list, no "present" mode and no automatic names ("Frame 1"); an unnamed frame shows "Frame".
- A frame's name is picked by one line's height above it, however long the name.
- A marquee selects shapes by their whole outline, including parts a frame cuts off.
- Esc doesn't step out of a group; click outside it.
- Groups can't be rotated when there's a frame in them (frames don't turn).
