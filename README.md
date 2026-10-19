# Niro

An open source, self-hostable whiteboard in the spirit of Miro, and a project for learning, from first principles, how canvas rendering, real-time collaboration and network transports work.

**Status:** P2 (shapes). Sticky notes, rectangles, ellipses and lines you can select, move, resize, rotate, recolor, reorder, duplicate and delete, with undo. Boards are saved in your browser; each visit to `/` starts a new board at its own `/b/<id>` link. Multiplayer arrives in P3a.

| To | Do |
|---|---|
| Pick a tool | Toolbar on the left, or `V` select, `H` hand, `N` sticky note, `R` rectangle, `O` ellipse, `L` line |
| Add a shape | Drag with a shape tool, or click for a default size. Shift keeps boxes square and lines at 15° steps |
| Select | Click, Shift + click to add or remove, drag a marquee on empty space, Ctrl/Cmd + `A` for all |
| Move, resize, rotate | Drag the shape, a handle, or the round handle above it. Shift locks the axis, the aspect ratio or 15° steps. Arrow keys nudge (Shift: 10px). Esc cancels a drag |
| Edit | Panel at the top: color, order, duplicate (Ctrl/Cmd + `D`), delete (`Delete`). `]` / `[` bring forward / send backward; with Shift, to the front / back |
| Undo, redo | Ctrl/Cmd + `Z`, Ctrl/Cmd + Shift + `Z` or Ctrl + `Y`, or the buttons under the toolbar |
| Pan | Scroll, two-finger trackpad scroll, space + drag, middle-button drag, the hand tool, or one finger on empty space on a touch screen |
| Zoom | Ctrl/Cmd + scroll, trackpad pinch, two-finger pinch on touch screens, or the buttons bottom-right. Ctrl/Cmd + `=`, `-`, `0` step in, out and back to 100% |

## Run it with Docker

```sh
docker compose up --build
```

Then open http://localhost:3000. The realtime server listens on http://localhost:8787 (`/healthz`, and WebSockets on `/ws`).

Set `POSTGRES_PASSWORD` before running anywhere other than your own machine. `WEB_PORT` and `REALTIME_PORT` change the published ports.

## Develop

Requires Node 22.22 or newer (24 recommended, see `.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm dev          # web on http://localhost:5173, realtime on :8787
```

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format check / auto-fix |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm build` | Production builds of the web app and realtime server |
| `pnpm e2e` | Browser tests (Playwright) against the production build; run `pnpm build` first |

## Layout

```
apps/web          React Router v8 app: the board UI and HTTP API
apps/realtime     WebSocket server: rooms, sync, presence, persistence
packages/engine   Framework-free canvas engine (no React, no Yjs)
packages/doc      Document model: shape types, DocStore, z-order and tree rules; Yjs adapter in @niro/doc/yjs
labs/             Learning labs (L6: Yjs vs Loro spike and benchmark)
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
| **P2** | Document model and shapes, selection, z-order, undo (after a Yjs vs Loro spike) |
| P3a | Multiplayer: rooms, sync, live cursors, share links |
| P3b | Persistence, limits, network-fault simulation tests, metrics |
| P4 | Text, pen, arrows, groups and frames |
| P5 | Performance: spatial index, culling, level of detail |
| P6 | v0.1 release |

## License

[MIT](LICENSE)
