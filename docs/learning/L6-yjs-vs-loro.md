# L6: What a CRDT stores, and why boards grow

The decision this lab fed is in [0001-sync-library.md](../decisions/0001-sync-library.md). This page explains the mechanics behind the numbers.

## Every change is an operation with an id

Both libraries give each peer an id: `clientID` in Yjs, `peerId` in Loro. Each peer also keeps a counter. Every change gets the pair `(peer, counter)`, so no two changes anywhere share an id. Syncing then means "send me the operations I haven't seen". A *state vector* (Yjs) or *version vector* (Loro) is just "the highest counter I've seen from each peer". That is why `syncY` and `syncLoro` in the spike are two lines each:

```ts
Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
b.import(a.export({ mode: "update", from: b.oplogVersion() }));
```

## Why concurrent edits converge

When two peers set the same key at the same time, each library picks a winner by comparing the operations' ids. The rule is arbitrary, but every peer applies the same rule to the same set of operations, so every peer picks the same winner. That's the whole trick: **convergence doesn't need agreement, only the same deterministic rule everywhere**.

Two people editing *different* properties of one shape keep both edits only if each property is its own register. That's why Niro stores each shape as a nested map (`Y.Map` per shape), not as one JSON value. If the whole shape were one value, the last writer would replace the other person's color change with their own stale copy.

## Why boards grow: tombstones

A peer that was offline may later send an operation that refers to a value someone has since overwritten. So the library can't simply forget the old value's *identity*. Yjs garbage-collects the old *content*, but it keeps a small record of the operation: who made it, where it was, and that it's deleted. That record is a tombstone. The bench measured about 10 bytes per overwritten map value in Yjs. A drag that writes `x` and `y` 60 times a second leaves 120 tombstones per second.

Loro keeps the full history too, but it encodes it in compressed columns, so the same session costs about a third as much. Loro can also export a *shallow snapshot*: current state with no history before a chosen point. That is compaction. The price is that a peer with offline edits from before that point can no longer merge them.

## Why trees are hard

A group is a parent link: `parentId` on each shape. Two peers can each make a valid move that, merged together, creates a cycle:
- Peer 1 moves A into B.
- Peer 2 moves B into A.

Each peer checked for cycles locally, and neither saw one. In Yjs, both `parentId` writes are just map sets on different keys, so both survive and the merged document has a cycle. The spike's first test shows exactly that.

Loro's movable tree implements Kleppmann et al.'s algorithm instead:
1. Moves are ordered by id.
2. Each move is applied in that order.
3. Any move that would create a cycle at the moment it is applied is skipped.

Every peer replays the same order, so every peer skips the same move.

Niro on Yjs gets the same guarantee more cheaply, by deriving an *effective parent* on read. If following parents from a shape revisits a shape, the cycle is broken at the member with the smallest id. Because the rule reads only the document, every peer computes the same tree, and nothing needs to be written back.

## Try it yourself

1. Run `pnpm vitest run labs` and read the eight tests. Each one is a two-peer scenario.
2. In the Yjs reparenting test, add a third peer that moves A to the top level concurrently. Predict the result before you run it.
3. Run `pnpm --filter @niro/lab-l6-yjs-vs-loro bench`. Then change the drag loop to set one `{x, y}` object per transaction instead of two keys, and see what happens to the size after the drags. The trade-off: one key means concurrent `x` and `y` edits can no longer merge separately.
