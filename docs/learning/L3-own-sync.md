# L3: Building your own sync, and testing it in a simulated world

The code is in [`labs/l3-own-sync`](../../labs/l3-own-sync). The simulated network it runs on is [`packages/netsim`](../../packages/netsim), which P3 will reuse to test the real sync server.

## The design: one server decides the order

Clients edit a shared key/value map. Every edit goes to the server. The server gives each edit the next sequence number (`seq`), applies it, and broadcasts it to everyone. All clients then apply the same edits in the same order, so they end up with the same map.

The conflict rule falls out of that: when two people set the same key at once, the edit that reaches the server last wins. Figma's multiplayer works on the same principle: a central server, and last-writer-wins per property.

## Edits show up at once

Waiting a round trip before showing your own edit feels laggy. So each client keeps two things:

- `confirmed`: the server's map, built from the ordered stream.
- `pending`: your edits the server hasn't confirmed yet.

What you see is `confirmed` with `pending` replayed on top. When your own edit comes back in the stream, it moves from `pending` to `confirmed`. If someone else's edit to the same key arrives first, you keep seeing yours, because the server will apply yours after theirs. Without that rule, the value would flicker to theirs and back to yours.

## Reconnecting

Connections drop. Each client remembers `lastSeq`, the last op it applied. On every reconnect it sends `hello { clientId, lastSeq }`. The server answers with a `welcome`:

- the ops after `lastSeq`, if its log still holds them, or
- a snapshot of the whole map, if it has trimmed them from its log.

Then the client resends everything still in `pending`.

### The bug that idempotency fixes

Picture this sequence:
1. Client A sets `x` to "a's edit". The server applies it.
2. A's connection dies before the confirmation gets back.
3. Client B sets `x` to "b's later edit".
4. A reconnects after the server has trimmed its log, so A gets a snapshot.

The snapshot says `x` is "b's later edit". It doesn't say whether A's edit is in there. If A just resends its pending edit, the server applies it a second time, and **B's newer edit is silently overwritten by a stale retry**.

The fix is an idempotency key. Every edit carries `(clientId, clientSeq)`, where `clientSeq` counts 1, 2, 3 for each client. The server remembers the highest `clientSeq` it applied for each client. It reports that number in the welcome as `acked`, so the client drops whatever already landed. And if a retry gets through anyway, the server ignores it.

Two tests in `sync.test.ts` play out this exact scenario, once with the record and once without it.

## Backoff with jitter

When a server restarts, every client notices at about the same moment. If they all reconnect instantly, and keep retrying instantly, they hammer the server just as it comes up: the "thundering herd". So each retry waits twice as long as the last, up to 10 seconds. Each wait is also half fixed and half random ("equal jitter", from Marc Brooker's AWS article on backoff and jitter), which spreads the clients out. The backoff test counts connection attempts against a dead server: 60 seconds of retrying makes fewer than 20 attempts, where retrying on every 1-second timeout would make 60.

## Testing it: deterministic simulation

Real networks rarely fail in the interesting ways while you're watching. So the tests never use real time or real sockets:

- **Virtual time.** `Simulation` is a queue of events ordered by time. Running it jumps straight to the next event, so ten simulated minutes take milliseconds.
- **One seed.** Every random choice comes from one seeded generator: latency, which client edits, when the network splits, when a node crashes. The same seed replays the exact same run.
- **A fake network.** `Network` gives you connections that behave like TCP (in order, no loss) until a partition or crash breaks them. Then messages in flight are lost, and each side notices after a random delay, the way a missed ping is noticed. It also has UDP-style datagrams that can be dropped, duplicated and reordered, for later labs.

`runScenario(seed)` in `fuzz.ts` sets up 2 to 5 clients. They make random edits while the network cuts clients off, clients crash and restart, and the server crashes and restarts. Then it heals everything, lets the run settle, and checks:

- every client sees exactly the server's map, with nothing left unconfirmed;
- the server applied each client's edits exactly once, in the order they were made;
- nobody saw a gap in the sequence numbers.

CI runs 1,000 seeds, which takes under a second. An average run has 3.5 clients, about 59 edits and 16 faults. `pnpm --filter @niro/lab-l3-own-sync fuzz` runs 50,000 seeds. When a seed fails, replay it with `runScenario(seed, { log: console.log })` and read what happened.

**Does the fuzz actually catch bugs?** To check, seven plausible bugs were planted one at a time:
- skipping the `acked` filter;
- not clearing pending edits when their echo arrives;
- an off-by-one in the "can the log catch you up" check;
- resending pending edits in reverse order;
- keeping the old `lastSeq` after a snapshot;
- not echoing an op back to its sender;
- sending edits before the welcome arrives.

The fuzz caught all seven within 1,000 seeds. With the server's idempotency record turned off, it fails 70 of the first 500 seeds, the first one being seed 13. The test suite keeps that last check, so the fuzz can't quietly lose its teeth.

This approach is borrowed from FoundationDB, whose team ran the database in a deterministic simulator from the start. TigerBeetle's VOPR is a more recent example.

## Assumptions this lab makes

- **The server's state is durable.** Each op is treated as written to disk before it's broadcast. If the server could lose its last few ops in a crash, clients would hold a `lastSeq` ahead of the server's.
- **The client's storage is durable.** If a client could lose its saved `nextClientSeq`, it would reuse sequence numbers after a restart, and the server would drop its new edits as "retries". The usual fix is a fresh `clientId` per session.
- **Last writer wins per key.** That's fine for a shape's color or position. It can't merge two people typing in the same sticky note: that needs a sequence CRDT or operational transforms (L4).

## Why Niro's board uses Yjs instead

This design is real: it is roughly how Figma does multiplayer. Niro picked a CRDT for three reasons:
- Edits merge without the server, which leaves the door open to offline-first and peer-to-peer.
- Text needs a sequence type anyway.
- Yjs ships the hard parts already tested.

See [0001-sync-library.md](../decisions/0001-sync-library.md). What carries over to P3 is everything around the merge rule: reconnect with `lastSeq`, snapshot fallback, idempotent retries, backoff, and the simulated network for testing it.

## Try it yourself

1. Fix `logLimit` at 1 in `runScenario` and count snapshots with `server.stats.snapshots`. As the map grows, when does a snapshot cost more than the ops it replaces?
2. Give a crashing client a 10% chance of losing its last save. Watch the fuzz fail, then fix it by giving a restarted client a new `clientId`.
3. Add per-link latency to `Network`, and give one client a 2-second link while the others stay at 50 ms. How long do its edits stay pending, and how often do they win?
