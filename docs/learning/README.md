# Learning log

Each lab in the roadmap ends with a short write-up here, explaining the idea in your own words: what problem it solves, how it works, and what surprised you. If it can't be written down clearly, it isn't learned yet.

| Lab | Topic | Write-up |
|---|---|---|
| L1 | Transform math: world vs screen coordinates, zoom toward the cursor | [L1-transforms.md](L1-transforms.md) |
| L2 | WebSocket from scratch on `node:net`: handshake, frames, masking | [L2-websocket.md](L2-websocket.md) |
| L3 | Your own last-writer-wins sync over a simulated network | [L3-own-sync.md](L3-own-sync.md) |
| L4 | Toy CRDTs: LWW-Map with Lamport clocks, RGA for text | _not yet_ |
| L5 | One chat app over gRPC, Connect, SSE and WebTransport | _not yet_ |
| L6 | What a CRDT stores: Yjs vs Loro, tombstones, movable trees | [L6-yjs-vs-loro.md](L6-yjs-vs-loro.md) |
| L7 | Decoding a Yjs update by hand | _not yet_ |
| L8 | WebGL instanced shape renderer | _not yet_ |

Milestone notes, on how the real thing works:

- [How multiplayer works in Niro](multiplayer.md): the two-step sync, presence, cursor smoothing, backpressure, dead connections, and how it's tested (P3a).
