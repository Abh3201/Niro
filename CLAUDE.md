# Niro: notes for coding agents

Open source whiteboard (TypeScript, React Router v8 framework mode, pnpm workspaces). See README.md for layout and commands.

## Before you say something is done

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`. All must pass.

## Architecture rules

- `packages/engine` never imports React or the sync library (Yjs/Loro). It owns its canvases and render loop.
- The engine talks to the document only through the `DocStore` interface in `packages/doc`.
- Presence (cursors, selections) never goes into the document.
- Never store the board document in React state.

## Quality bar

For any plan, design, review or non-trivial change: critique your own draft as a senior principal engineer, verify the facts it depends on (library versions and capabilities change fast), revise, and state confidence and known weaknesses. Don't wait to be asked for a review.
