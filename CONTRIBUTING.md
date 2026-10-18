# Contributing to Niro

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome. For anything bigger than a fix, open an issue first so we can agree on the approach before you spend time on it.

## Set up

You need Node 22.22 or newer (24 recommended, see `.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm dev          # web on http://localhost:5173, realtime on :8787
```

The [README](README.md) explains the layout and every command. Without `DATABASE_URL`, the realtime server keeps boards in memory, which is all you need for most work. For the storage tests, point `TEST_DATABASE_URL` at any Postgres you don't mind tests writing to, for example:

```sh
docker run -d --name niro-test-pg -p 5433:5432 \
  -e POSTGRES_USER=niro -e POSTGRES_PASSWORD=niro -e POSTGRES_DB=niro postgres:18-alpine
export TEST_DATABASE_URL=postgres://niro:niro@localhost:5433/niro
```

## Before you open a pull request

Run the whole check; CI runs the same:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e
```

`pnpm e2e` tests the production build, so it needs `pnpm build` first (the line above does that). The first time, `pnpm exec playwright install chromium` downloads the browser.

If you changed how the board draws, also run `pnpm bench` before and after, and put the numbers in the pull request.

## Rules the code keeps

- **`packages/engine` never imports React or the sync library** (Yjs, Loro). It owns its canvases and render loop, and talks to the board only through the `DocStore` interface in `packages/doc`. `pnpm lint` enforces the imports.
- **Presence (cursors, selections, names) never goes into the document.** It's sent separately and forgotten when someone leaves.
- **The board document never goes into React state.** React renders the frame around the board; the engine draws the board.
- **Every change to shapes goes through one transaction**, so undo and sync see it as one step. In the engine, that's `transact` in `board-tx.ts`.
- **The document schema only grows.** Old boards must open in new versions. A change to stored shapes raises `SCHEMA_VERSION` in `packages/doc/src/shape.ts` and adds a migration, with a test, in `packages/doc/src/yjs.ts`.

Big decisions are written down in [docs/decisions](docs/decisions), with the evidence behind them. If your change goes against one, say so in the pull request, and add a new record if it's accepted.

## Tests

- Unit tests sit next to the code (`*.test.ts`) and run with Vitest. Logic that has to hold for any input (z-order, the tree of frames and groups, sync) has property tests with fast-check.
- Browser tests are in `e2e/` and run with Playwright against the built app. Use the helpers in `e2e/helpers.ts`.
- A bug fix comes with a test that fails without it.

## Pull requests

- Keep each one to one change, with a title that says what it does for someone using Niro.
- Describe what someone would see before and after, and how you checked it.
- Add a line to the top section of [CHANGELOG.md](CHANGELOG.md) for anything a user or self-hoster would notice.

By contributing, you agree that your contributions are licensed under the project's [license](LICENSE).
