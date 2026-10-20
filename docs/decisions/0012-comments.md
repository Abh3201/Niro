# 0012: Comments live in the board document, written by anyone who can edit

- Status: accepted
- Date: 2026-10-20
- Code: [`packages/doc/src/comments.ts`](../../packages/doc/src/comments.ts), [`apps/web/app/board/Comments.tsx`](../../apps/web/app/board/Comments.tsx), `boundsOf` and `shapeAt` in [`packages/engine/src/engine.ts`](../../packages/engine/src/engine.ts)

## Decision

- **Comments are in the Y.Doc**, in a `comments` map beside `shapes`: one entry per thread, with the pin's place, `resolved`, and a list of messages. A message is written once and never edited, so two people replying at once both keep their reply.
- **A pin is on a place or on a shape.** Pressing `C` and clicking drops one; if the click is on a shape, the pin remembers its offset from that shape's top-left and follows the shape when it moves (it always knows the world point it was dropped at, which it falls back to if the shape is deleted).
- **The engine doesn't draw them.** Pins are ordinary page elements placed from the camera, `boundsOf` and the document; the engine only gained two read-only questions (`boundsOf(id)`, `shapeAt(point)`). The shape store (`DocStore`) doesn't know comments exist, and they aren't in the PNG/SVG export.
- **Who can do what:** people with an edit link add threads, reply, resolve, reopen and delete a thread. A view link sees pins, threads and the list, and can do none of that (the server refuses a viewer's changes to the document, and comments are in it).
- **Names come from the identity this browser already uses for presence**, stored in each message with the browser's id and color. There are no accounts, so a name is a label, not proof of who wrote it.
- **"New" is per browser:** the browser remembers how many messages of each thread it has seen (`localStorage`); a thread with more, last written by someone else, gets a ring on its pin. There are no emails or push notifications, because there is nobody to send them to.
- Limits: 2,000 characters a message, 200 messages a thread. Comments count toward the board's size limit like anything else in the document. No format version bump: older clients don't know the `comments` map and leave it alone.

## Why

- **In the document is the only place that needs no new concepts.** It syncs, works offline, is stored and versioned (decision 0011) with the board, and travels with a board copy. A separate table would need identity to decide who may see or write comments, which is the accounts question this project has deferred.
- Pins as page elements keep the engine free of a feature that has text input, popovers and a list, all of which are page work already.

## What this gives up

- **Anyone with an edit link can delete any thread** and write under any name. Same trust as the rest of an edit link, which can already delete the board's contents.
- **No comments from view links.** A "commenter" role would need a role between view and edit that the server can enforce, because the document is writable only by editors. Worth doing once accounts exist.
- **No notifications beyond the ring on a pin.** Someone who doesn't open the board never hears about a reply.
- **Messages can't be edited or deleted**, only whole threads.
- **Undo doesn't cover comments**: the shape undo history tracks shapes only.
- **A pin whose shape is deleted stays where it was first dropped**, which may not be where the shape was last.
- **With thousands of threads** the pins are plain DOM elements recomputed on every camera change; fine into the hundreds, a reason to cluster them later.
