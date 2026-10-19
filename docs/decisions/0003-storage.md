# 0003: Boards are stored as Yjs updates in Postgres, written in batches, and a full board turns read-only

- Status: accepted
- Date: 2026-10-17
- Code: [`packages/sync/src/host.ts`](../../packages/sync/src/host.ts), [`apps/realtime/src/postgres.ts`](../../apps/realtime/src/postgres.ts), [`apps/realtime/src/server.ts`](../../apps/realtime/src/server.ts)

## Decision

- **Format: Yjs updates, not shapes.** A board is a snapshot (one update holding everything) plus the updates written since. The server never needs to understand shapes to store them, a migration of the shape format never touches the database, and loading is one `Y.mergeUpdates`. The cost: the database can't be queried for "boards with more than 100 stickies" without decoding.
- **Tables:** `boards (id, snapshot, created_at, updated_at)` and `board_updates (board_id, seq, data)`. Appending inserts a row; compaction replaces the snapshot and deletes the rows in one transaction; loading reads both in one statement, so it never sees half a compaction. Migrations are numbered SQL run under an advisory lock, so servers starting together don't race.
- **Writes are batched:** 2 s after the last change, at most 10 s after the first unwritten one. Every 100 writes, the rows are compacted into the snapshot. A failed write is kept and retried every 5 s.
- **Losing the server loses at most one batch, and not even that while a browser has the board.** Browsers keep boards in IndexedDB and send the server whatever it lacks when they reconnect.
- **Limits turn the board read-only for everyone** (10,000 shapes, about 20 MB). Refusing single CRDT updates would leave copies that never agree again; refusing everything after the line keeps them equal. The browser shows why.
- **`MemoryStorage` without `DATABASE_URL`,** for development and tests. In production the server refuses to start without a database.

## What this gives up

- **One realtime server per database.** Two servers with the same board open would each compact away the other's rows. Running more than one needs boards routed to servers (by board id) first.
- **A full board stays full.** Deleting shapes to make room is an edit, so it's refused too. Map deletions add no structs to a Yjs update, so they could be recognized and let through later.
- **Size is estimated between measurements.** The server adds up the bytes of each change and measures the real size (by encoding the whole board) only when the estimate passes the limit, then not again until another 5% has changed. A board can end up that much over the limit.

## Alternatives considered

- **Write every update as it arrives:** simplest and loses nothing, but a drag writes sixty rows a second. Batching costs at most 10 s of edits on a crash, which browsers usually hold anyway.
- **Store shapes as rows:** queryable, but every edit means decoding CRDT state on the server, and concurrent edits to one shape would need the CRDT's merge in SQL.
- **An existing adapter** (`y-postgresql`, or `@hocuspocus/extension-database` with the Hocuspocus server): would work. Writing our own keeps the host testable on the simulated network, which is how the relay bug in [the P3b write-up](../learning/multiplayer.md#how-its-tested) was found.
