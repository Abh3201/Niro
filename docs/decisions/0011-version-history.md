# 0011: Version history is full states kept by the realtime server

- Status: accepted
- Date: 2026-10-20
- Code: [`apps/realtime/src/versions.ts`](../../apps/realtime/src/versions.ts), [`apps/realtime/src/server.ts`](../../apps/realtime/src/server.ts) (`versionHandler`), [`packages/doc/src/yjs.ts`](../../packages/doc/src/yjs.ts) (`restore`), [`apps/web/app/board/HistoryPanel.tsx`](../../apps/web/app/board/HistoryPanel.tsx)

## Decision

- **A version is the board's whole Yjs state at a moment**, stored in Postgres (`board_versions`, migration 3) beside the board. The live document is unchanged.
- **Saved two ways.** People with an edit link save one by hand, with an optional name. The server saves one by itself when a board is written and its newest version is more than 30 minutes old (or it has none). Restoring first saves the board as it is now, as "Before restoring …".
- **Limits per board:** 30 versions and 25 MB together (`NIRO_MAX_VERSIONS`, `NIRO_MAX_BOARD_VERSIONS_MB`). Past either, the oldest versions the server saved go first, then the oldest saved by hand; the one just saved is never dropped. A board whose state alone is over the byte limit keeps none. Saving by hand is limited to once every 2 seconds per board.
- **Looking** at a version loads its state into a Yjs document of its own and draws it in a second, view-only engine in a dialog. The live board is not touched.
- **Restoring is a forward edit.** `YDocStore.restore(state)` edits the live shapes to match the version in one transaction: shapes missing from the board come back, extra ones are removed, fields that differ are set, text is edited by its changed middle. Collaborators receive it as an ordinary change, and Ctrl+Z reverts it as one step.
- Reading (list, preview) takes any board token; saving takes an edit token. No format version bump: nothing about the document changes.

## Why

- **Yjs snapshots need `gc: false`**, which keeps every deleted item for the life of the board, so every board grows forever, for everyone, whether or not anybody ever looks at history. Full states cost disk only where a version was kept, and old ones are dropped.
- **A rewind would lose other people's work.** Replacing the document with an old state would discard whatever collaborators did since, and clients holding the newer state would merge it straight back. An edit that makes the board match the old one is just another change, so it converges like any other.
- The server already holds the full state (it writes it for compaction), so saving needs no client upload and a client can't save a state the board never had.

## What this gives up

- **Restore replaces everything, not a part.** Taking one deleted shape out of an old version isn't possible yet: the preview is view-only, so it can't be copied from there.
- **Automatic versions are coarse.** One per 30 minutes of writing, taken after the change that triggered it, so a mistake in the first minutes after a version still shows in it. Saving by hand before a risky edit is the precise tool.
- **Concurrent editing during a restore:** someone moving a shape at the moment of a restore may have that move overwritten or kept, whichever Yjs orders last. The board converges either way, and the "Before restoring" version has the state just before.
- **Reactions are part of a shape's fields** and revert with it.
- **Images** are not versioned: a version holds only an image's id, and files are never removed from the server, so restored images still load.
- **Anyone with an edit link can fill the history** with saves and so push older versions out (at most one per 2 seconds). They can also delete the board; this adds no new power.
- **Postgres size:** up to 25 MB of versions per board on top of the board and its images. Self-hosters can lower it.
