# 0001: Yjs for the board document in v0.1, behind `DocStore`

- Status: accepted
- Date: 2026-10-17
- Evidence: [`labs/l6-yjs-vs-loro`](../../labs/l6-yjs-vs-loro) (behavior tests run in CI; `pnpm --filter @niro/lab-l6-yjs-vs-loro bench` for the numbers)

## Decision

Niro v0.1 stores the board in **Yjs 13.6** (`yjs@13.6.33`), and only `packages/doc` imports it. The engine and the app talk to the document through the `DocStore` interface, so moving to Loro later means writing one adapter and a one-time board conversion. Nothing else changes.

## What we needed, and what each library does

The behavior tests in [`spike.test.ts`](../../labs/l6-yjs-vs-loro/src/spike.test.ts) pass on both libraries as written:

| Need | Yjs 13.6.33 | Loro 1.16.4 |
|---|---|---|
| Two people edit different properties of one shape at once; both edits survive | Yes, with a nested `Y.Map` per shape | Yes, with a `LoroMap` per tree node |
| Two people edit the same property; every peer ends with the same value | Yes | Yes |
| Undo reverts only my own changes, not a collaborator's | Yes, `UndoManager` with `trackedOrigins` | Yes, `UndoManager` tracks the local peer |
| A puts X into group Y while B puts Y into group X | **Converges to a cycle.** The app must repair it | **Drops one move.** No cycle, no app code |
| Stable z-order under concurrent inserts | App supplies fractional keys (`fractional-indexing`) | Built into the tree (`enableFractionalIndex`) |
| Presence (cursors, selections) outside the document | `y-protocols/awareness` | `EphemeralStore` |

## Measurements

10,000 rectangles, each with 9 properties. Then 100,000 small transactions that move 100 of them, which is what a long session of dragging produces. Node 22.22, measured on 2026-10-17. Timings vary by run and machine. The byte counts are deterministic.

| Metric | Yjs | Loro |
|---|---|---|
| Library, min+gzip JS | 28 KB | 15 KB |
| Library, gzip WebAssembly | none | **1,104 KB** |
| Create 10,000 shapes | 81–92 ms | 236–253 ms |
| Encoded board, 10,000 shapes | 1,939 KB | **751 KB** |
| Load and materialize the encoded board | 149–155 ms | 173–176 ms |
| 100,000 drag transactions | 339–341 ms | 559–589 ms |
| Encoded board after the drags | **3,892 KB** | 1,223 KB (489 KB as a shallow snapshot) |

What the numbers say:

- **Loro costs 1.1 MB more to download**, gzipped, before the first shape can render. Every visitor who opens a shared link for the first time pays that.
- **Yjs boards are about 2.6 times larger, and they grow with every edit.** Every overwritten map value leaves a tombstone of about 10 bytes ((3,892 − 1,939) KB ÷ 200,000 overwrites). Loro's history compresses much better, and its shallow snapshot is a real compaction tool. Yjs can only shrink a board by starting a new document, which every connected client has to reload.
- Both libraries are fast enough. The slowest number in the table is 0.6 s for 100,000 transactions.

## Why Yjs anyway

1. **First load matters more than storage size for v0.1.** The pitch is "open a link and you're on the board". 1.1 MB of WebAssembly has to download and compile before any of it happens. Storage size is a server cost, and the limits planned for P3b cap it.
2. **The one correctness feature Loro has and Yjs lacks is cheap to build.** Cycle repair for groups is a pure function over `parentId` links, about 50 lines with property tests. It is also exactly the kind of thing this project exists to teach.
3. **The ecosystem is more mature.** These npm versions were checked 2026-10-17:
   - Yjs side: `y-protocols` 1.0.7, `y-indexeddb` 9.0.12, `y-websocket` 3.1.0, and Tiptap collaboration 3.32 for rich text after v0.1.
   - Loro side: the equivalents are at 0.x (`loro-websocket` 0.6.2, `loro-protocol` 0.3.0, `loro-prosemirror` 0.4.4).
   - Download counts could not be fetched from this sandbox, so "more widely used" is inferred, not measured.
4. **The P3a sync protocol is y-protocols.** It is small, documented, and becomes the reference implementation L3 is compared against.

## Costs we accept, and how we contain them

- **Tombstone growth.**
  - During a drag, write to the document at most once per animation frame.
  - Store position as `x` and `y` in one transaction, so each frame adds 2 tombstones, not more.
  - The document and shape limits in P3b bound the worst case.
  - At 60 writes per second and 2 properties, a 2-second drag adds roughly 2.4 KB (inferred from the measured 10 bytes per overwrite).
- **Cycle repair.** `packages/doc` computes an *effective parent* when it reads: in a cycle, the shape with the smallest id is treated as top level. Every peer computes the same answer from the same document, so the repair never has to be written back and can't race. It ships with property tests in P2. Groups and frames arrive in P4.
- **Yjs 14.** `yjs@14.0.0-16` is in beta (`npm view yjs dist-tags`, 2026-10-17). We stay on 13.6 and revisit when 14 is stable. The `DocStore` boundary keeps that upgrade inside one package.

## When to revisit

Any of these reopens the decision:
- Real boards regularly exceed the P3b document limit because of tombstones.
- Loro's WebAssembly drops below about 400 KB gzipped, or we find a way to render a read-only board before it loads.
- Yjs 14 ships with a migration cost similar to switching libraries.
- We need server-side validation of edits, for example locked shapes. Neither CRDT gives us that: the server relays merge blobs it can't easily inspect, so that need would point toward a server-authoritative model instead.

## Confidence

- **70% that Yjs is the right choice for v0.1.** That is up from 60% before the spike: the measurements made Loro's main cost concrete, and its main advantage turned out to be cheap to replicate.
- **90% that one of the two is right.**
- **Known weaknesses of this record:**
  - The measurements come from one synthetic board on Node, not from a browser.
  - Memory use was not measured.
  - WebAssembly compile time on a slow phone was not measured, and it could make the bundle cost look better or worse than the download size suggests.
