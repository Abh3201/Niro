# Niro

An open source, self-hostable whiteboard in the spirit of Miro, and a project for learning, from first principles, how canvas rendering, real-time collaboration and network transports work.

**Status:** v0.1 nearly done (P6: export, keyboard and screen-reader support, docs). Sticky notes, rectangles, ellipses, lines, arrows, pen strokes and text you can select, move, resize, rotate, recolor, reorder, duplicate and delete, with undo; text in every box shape; arrows that stay attached to the shapes they connect; groups, and frames that hold and clip what's in them. Each visit to `/` starts a new board; share its link and others edit it with you live, with everyone's cursors and selections on screen. Boards are saved on the server (Postgres) and in each browser, so they work offline and survive restarts. A 10,000-shape board pans in about 5 ms a frame at 100% (measured; see [the performance notes](docs/learning/performance.md)). Export to PNG or SVG; move through shapes with the keyboard; screen readers can read the board.

| To | Do |
|---|---|
| Pick a tool | Toolbar on the left, or `V` select, `H` hand, `N` sticky note, `T` text, `R` rectangle, `O` ellipse, `L` line, `A` arrow, `P` pen, `F` frame |
| Add a shape | Drag with a shape tool, or click for a default size. Shift keeps boxes square and lines at 15° steps |
| Draw | The pen draws until you pick another tool. A pen that senses pressure draws thicker when pressed harder; with a mouse or a finger, the line thins as it speeds up |
| Connect | Drag the arrow tool from one shape to another: the arrow stays attached to both as they move. Drag an arrow's end onto a shape to attach it, or off to let go. Moving an arrow on its own lets go of both shapes |
| Write | Type on a new sticky note. Double-click a shape, or select it and press `Enter`, to edit its text; `Esc` or a click elsewhere finishes. The text tool, or a double-click on empty space, starts a text; drag with the tool to set its width. Text in shapes shrinks to fit |
| Frame | Drag with the frame tool around shapes to put them in it; shapes dragged in or out join or leave it. Double-click the name above it to rename it. Drag a frame by its name or edge, or anywhere inside once selected |
| Group | Ctrl/Cmd + `G` groups the selection, Ctrl/Cmd + Shift + `G` takes a group apart, or the buttons in the panel. A click picks the whole group; double-click to pick a shape inside it |
| Select | Click, Shift + click to add or remove, drag a marquee on empty space (or inside a frame, to pick what's in it), Ctrl/Cmd + `A` for all |
| Move, resize, rotate | Drag the shape, a handle, or the round handle above it. Shift locks the axis, the aspect ratio or 15° steps. Arrow keys nudge (Shift: 10px). Esc cancels a drag |
| Edit | Panel at the top: color, order, duplicate (Ctrl/Cmd + `D`), delete (`Delete`). `]` / `[` bring forward / send backward; with Shift, to the front / back |
| Undo, redo | Ctrl/Cmd + `Z`, Ctrl/Cmd + Shift + `Z` or Ctrl + `Y`, or the buttons under the toolbar |
| Pan | Scroll, two-finger trackpad scroll, space + drag, middle-button drag, the hand tool, or one finger on empty space on a touch screen |
| Zoom | Ctrl/Cmd + scroll, trackpad pinch, two-finger pinch on touch screens, or the buttons bottom-right. Ctrl/Cmd + `=`, `-`, `0` step in, out and back to 100% |
| Export | `PNG` or `SVG` bottom-right downloads the selection, or the whole board when nothing is selected, in light colors on white |
| Keyboard | `Tab` / Shift + `Tab` step through shapes in reading order (frames, then what's in them), and past the last shape on to the rest of the page. `?` lists every shortcut. Screen readers announce the selected shape and can read a list of the board's shapes |
| Share | **Share**, top right: an edit link and a view-only link, and your name as others see it. Whoever has a link has that access; there are no accounts |

## Run it with Docker

```sh
echo "NIRO_SECRET=$(openssl rand -hex 32)" > .env
docker compose up --build
```

Then open http://localhost:3000. To run it on a server with HTTPS on your own domain, add `compose.https.yml`: **[docs/self-hosting.md](docs/self-hosting.md)** walks through that, other reverse proxies, backups, upgrades and monitoring.

The realtime server listens on http://localhost:8787: WebSockets on `/ws`, `/healthz`, and `/metrics` in the Prometheus format. Boards are kept in the `pgdata` volume; `docker compose down -v` deletes them.

`NIRO_SECRET` signs share links: keep it private, and keep it the same across restarts, or every link stops working. [`.env.example`](.env.example) lists the other settings:

- `POSTGRES_PASSWORD`: set it before running anywhere other than your own machine.
- `WEB_PORT` and `REALTIME_PORT`: change the published ports.
- `PUBLIC_REALTIME_URL`: where browsers open the WebSocket (`ws://` or `wss://`). By default, the web app's host on port 8787. Set it behind a reverse proxy, with HTTPS, or if you change `REALTIME_PORT`.
- `METRICS_TOKEN`: makes `/metrics` require `Authorization: Bearer <token>`. Set it when port 8787 is reachable from the internet.
- `NIRO_MAX_SHAPES` (10,000), `NIRO_MAX_BOARD_MB` (20) and `NIRO_MAX_CONNECTIONS_PER_BOARD` (100): limits. A board that reaches the first two turns read-only for everyone, and says so.

Run one realtime server per database: two would each compact away the other's writes. Outside Docker it needs `DATABASE_URL`, unless `NODE_ENV` isn't `production`, when it keeps boards in memory.

How share links work, and what they can't do (revoke one link): [docs/decisions/0002-sharing.md](docs/decisions/0002-sharing.md). How boards are stored, and the limits: [docs/decisions/0003-storage.md](docs/decisions/0003-storage.md).

## Develop

Requires Node 22.22 or newer (24 recommended, see `.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm dev          # web on http://localhost:5173, realtime on :8787
```

In development both servers use a built-in secret; set `NIRO_SECRET` to use your own. Without `DATABASE_URL` the realtime server keeps boards in memory, so they last until it restarts (browsers keep their copies). To run the storage tests, point `TEST_DATABASE_URL` at any Postgres: each test works in a schema of its own and drops it.

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format check / auto-fix |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm build` | Production builds of the web app and realtime server |
| `pnpm e2e` | Browser tests (Playwright) against the production build; run `pnpm build` first |
| `pnpm bench` | Frame times on a seeded 10,000-shape board, written to `bench-results.json`; run `pnpm build` first |

## Layout

```
apps/web          React Router v8 app: the board UI and HTTP API
apps/realtime     WebSocket server: rooms, sync, presence, persistence
apps/bench        Rendering benchmark: the engine on a seeded 10,000-shape board, timed by Playwright
packages/engine   Framework-free canvas engine (no React, no Yjs)
packages/doc      Document model: shape types, DocStore, z-order and tree rules; Yjs adapter in @niro/doc/yjs
packages/sync     Realtime sync on Yjs: the server's Room and RoomHost (loading, saving, limits), the browser's SyncClient, share-link keys and tokens
packages/netsim   Deterministic simulated network for fault-injection tests
labs/             Learning labs: L2 WebSocket from scratch, L3 own sync, L4 toy CRDTs, L6 Yjs vs Loro
docs/decisions    Decision records, with the evidence behind them
docs/learning     Write-ups from the learning labs
```

Two rules keep the architecture honest:

- **The engine never imports React.** React renders a container; the engine owns the canvases and its render loop.
- **The engine never imports the sync library.** It talks to `DocStore`, so Yjs (or Loro) stays behind one adapter. Why Yjs: [docs/decisions/0001-sync-library.md](docs/decisions/0001-sync-library.md).

`pnpm lint` enforces both: Biome rejects imports of React, Yjs, Loro or `@niro/doc/yjs` inside `packages/engine`.

## Roadmap

| Milestone | Scope |
|---|---|
| P0 | Monorepo, web app, realtime stub, Docker compose, CI |
| P1 | Camera: pan, zoom, pinch, HiDPI, render only when something changed |
| P2 | Document model and shapes, selection, z-order, undo (after a Yjs vs Loro spike) |
| P3a | Multiplayer: rooms, sync, live cursors, share links |
| P3b | Persistence, limits, network-fault simulation tests, metrics |
| P4 | Text, pen, arrows, groups and frames |
| P5 | Performance: spatial index, culling, level of detail |
| **P6** | v0.1 release: export, keyboard and screen readers, self-hosting docs |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). What changed in each release: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
