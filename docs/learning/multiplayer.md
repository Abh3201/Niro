# How multiplayer works in Niro (P3a)

This is the production version of what labs L2 and L3 built by hand. The sync code is in [`packages/sync`](../../packages/sync), the server in [`apps/realtime`](../../apps/realtime), and the browser side in [`apps/web/app/board`](../../apps/web/app/board).

## Three channels on one WebSocket

Every message starts with a type number, the same framing as y-websocket so the format is well known:

| Type | Carries | Kept? |
|---|---|---|
| 0, sync | Document changes (Yjs updates) and the catch-up handshake | Yes, it is the board |
| 1, awareness | Presence: name, color, cursor, selection | No, it disappears when you leave |
| 4, heartbeat | Nothing; proves the connection is alive | No |

Presence never goes into the document. A cursor moving 20 times a second would otherwise become thousands of permanent edits per minute, and everyone's undo history would fill with other people's mouse movements.

## Catching up: the two-step sync

When a browser connects, neither side knows what the other has. Both send a **state vector**: for each client that ever edited the board, how many changes from it they have. A state vector is small, a few bytes per editor, however big the board is.

1. The room sends its state vector (step 1). The browser answers with every change the room is missing (step 2).
2. The browser sends its state vector. The room answers with every change the browser is missing. When that answer arrives, the browser is caught up and shows **Live**.

After that, each change is sent as it happens and relayed to everyone else in the room.

**The document is the queue.** There is no list of unsent edits to keep, persist or replay. Edits made offline are already in the document (and in IndexedDB); the next handshake finds them because the room's state vector doesn't cover them. That is why reconnecting is just "do the handshake again", and why it's safe to drop a connection at any moment.

Compare lab L3, where the server put every edit in one order and clients kept a `pending` list. Yjs needs no central order: concurrent changes merge the same way whatever order they arrive in, so the server is only a relay and a meeting point, not a referee.

## Presence: awareness

Each browser has an awareness client id and a state (its name, color, cursor and selection), with a clock that goes up on every change. Receivers keep a state only if its clock is newer than the one they have.

Two details the fuzz test forced:

- **Re-announce on reconnect, with a new clock.** Others saw you leave and kept your old clock, so they'd ignore your old state if you sent it again unchanged.
- **Forget everyone's clocks when you disconnect**, not just their states. Otherwise, on reconnect, the room re-sends their current states, and you'd ignore any whose clock hadn't moved while you were away. They'd be invisible to you until they next moved their mouse.

The server checks presence a little: a connection speaks for one client id (the first one it names), and a state over 16 KB is dropped. It isn't authenticated; see [decision 0002](../decisions/0002-sharing.md).

## Drawing other people's cursors

Cursors arrive at most 20 times a second, so drawn as received they jump every 50 ms. The engine eases each drawn cursor toward the last reported position instead: every frame it covers `1 - e^(-dt/60ms)` of the remaining distance. That is exponential smoothing, and it has a useful property: two frames of 8 ms move a cursor exactly as far as one frame of 16 ms, so it looks the same at any frame rate. The cost is about one update of lag. The engine keeps drawing frames only while some cursor is still more than a quarter pixel from its target, so an idle board still draws nothing.

## When a connection falls behind

A browser on a slow link can't receive as fast as the room sends. The server watches each connection's send buffer:

- Above 256 KB, it skips presence messages to that browser. The next cursor update replaces a skipped one, so nothing is lost.
- Above 8 MB, it drops the connection. That browser catches up faster with a new handshake, which sends what it's missing once, than by receiving every intermediate change.

Document changes are never skipped: skipping one would leave a gap the browser couldn't detect until its next handshake.

## Dead connections

A closed laptop sends no close frame, and TCP can take many minutes to notice. So:

- The server pings every 30 seconds and drops connections that missed the previous ping.
- Browsers can't see WebSocket pings from JavaScript, so the browser sends its own heartbeat message every 15 seconds and reconnects after two silent intervals.

Reconnects back off exponentially from 0.5 s up to 15 s, with "equal jitter" (half the wait fixed, half random, from lab L3) so a server restart doesn't bring every browser back in the same millisecond. When the browser says the network is back (`online` event), it skips the wait.

## How it's tested

- **Fuzzing on a simulated network.** [`packages/sync/src/fuzz.ts`](../../packages/sync/src/fuzz.ts) runs the real `Room` and `SyncClient` on [`packages/netsim`](../../packages/netsim) with random edits, network partitions, browser crashes and server crashes, then checks that everyone converges, no typed character is lost, and every browser shows exactly the people who are there. CI runs 1,000 seeds; `pnpm --filter @niro/sync fuzz` runs 10,000.
- **Mutation testing of the fuzz itself.** Seven bugs were planted one at a time (no re-announce, stale clocks, the room not answering step 1, and others). The fuzz caught each one within 1,000 seeds; a fuzz that can't catch planted bugs proves nothing.
- **A real server** in [`apps/realtime/src/server.test.ts`](../../apps/realtime/src/server.test.ts): token checks on upgrade, two editors and a viewer syncing, presence relay, shutdown.
- **Two browsers** in [`e2e/multiplayer.spec.ts`](../../e2e/multiplayer.spec.ts): shapes, a cursor and a name crossing between two Chromium contexts, and a view link that can't change anything.

## What P3a doesn't do yet

Rooms live in the realtime server's memory. When everyone leaves a board, the server forgets it, and the board lives on in the browsers that had it open (IndexedDB). The next person to open it brings it back. P3b stores boards in Postgres.
