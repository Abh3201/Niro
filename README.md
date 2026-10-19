# Niro

An open source, self-hostable whiteboard in the spirit of Miro, and a project for learning, from first principles, how canvas rendering, real-time collaboration and network transports work.

**Status:** P1 (camera). An infinite dot-grid canvas you can pan and zoom, with a placeholder rectangle at the origin. Shapes arrive in P2.

| To | Do |
|---|---|
| Pan | Drag, scroll, two-finger trackpad scroll, space + drag, or middle-button drag |
| Zoom | Ctrl/Cmd + scroll, trackpad pinch, two-finger pinch on touch screens, or the buttons bottom-right |
| Zoom in, out, reset | Ctrl/Cmd + `=`, `-`, `0` |

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
packages/doc      Document model: shape types and the DocStore interface
docs/learning     Write-ups from the learning labs
```

Two rules keep the architecture honest:

- **The engine never imports React.** React renders a container; the engine owns the canvases and its render loop.
- **The engine never imports the sync library.** It talks to `DocStore`, so Yjs (or Loro) stays behind one adapter.

## Roadmap

| Milestone | Scope |
|---|---|
| P0 | Monorepo, web app, realtime stub, Docker compose, CI |
| **P1** | Camera: pan, zoom, pinch, HiDPI, render only when something changed |
| P2 | Document model and shapes, selection, z-order, undo (after a Yjs vs Loro spike) |
| P3a | Multiplayer: rooms, sync, live cursors, share links |
| P3b | Persistence, limits, network-fault simulation tests, metrics |
| P4 | Text, pen, arrows, groups and frames |
| P5 | Performance: spatial index, culling, level of detail |
| P6 | v0.1 release |

## License

[MIT](LICENSE)
