# 0007: An R-tree for what's on screen, less detail when zoomed out, and frame times as a trend

- Status: accepted
- Date: 2026-10-18
- Code: [`packages/engine/src/scene.ts`](../../packages/engine/src/scene.ts), [`packages/engine/src/render.ts`](../../packages/engine/src/render.ts), [`packages/engine/src/text.ts`](../../packages/engine/src/text.ts), [`apps/bench`](../../apps/bench)

## Decision

- **The scene keeps every shape's drawn box in an R-tree** ([rbush](https://github.com/mourner/rbush) 4.0.1, MIT). Drawing asks it for the shapes overlapping the view; hit testing and marquee selection ask it for the shapes near the pointer or inside the box. Answers come back in draw order, using each shape's place in that order.
- **A shape's drawn box is worked out by the code that draws it** (`drawnExtent` in `render.ts`): the outline, plus line caps and arrowheads, the pen's width, a sticky note's shadow, and text that can reach past the outline (a frame's name, a text shape's lines). The scene takes it as an option, so the index never leaves out something that's drawn.
- **Less detail when zoomed out**, by size on screen: a sticky note under 16 CSS pixels has no shadow; text under 2.5 pixels isn't drawn, and under 4 pixels it's drawn as grey bars (this was already there). Upright shapes are drawn without moving the canvas to each one.
- **Text layouts are kept per shape**, however many shapes there are.
- **Frame times are measured in CI and never fail the build.** `pnpm bench` times seven scenarios on a seeded 10,000-shape board and writes the numbers to the job summary and a `bench-results.json` artifact.

## Why

Measured on the benchmark board (10,000 shapes; 1440 × 900 at 2× pixels; headless Chromium drawing in software, so slower than a laptop with a GPU). Milliseconds per frame, median, including the time the canvas takes to finish drawing:

| Scenario | Before | After |
|---|---|---|
| Pan at 100% | 146 | 5.4 |
| Pan at 25% | 185 | 9.7 |
| Pan fully zoomed out (5%) | 141 | 20.3 |
| Zoom from 5% to 100% and back | 165 | 9.2 |
| Move a note (a collaborator's edit) | 158 | 8.5 |
| Add a note | 164 | 19.6 |

- **Before, every frame drew every shape**, and every frame laid out text again: the layout cache held 5,000 entries and was emptied whenever it filled, so a board with more texts than that measured all of them on every frame. The profile showed text measuring at about a third of the time.
- **An R-tree, not a grid.** Shapes on a whiteboard range from a 10-unit dot to a 5,000-unit frame, and boards have no fixed size; a uniform grid needs a cell size that suits both. rbush handles any sizes, updates one shape at a time (a drag moves a few shapes per frame), and loads a whole board in one go when it opens.
- **The order comes from the scene, not the tree.** Draw order depends on the tree of groups and frames and on fractional indexes; keeping it in one place (the scene's ordered list) and marking which entries the R-tree found keeps the two from disagreeing.
- **No threshold in CI.** GitHub's shared runners draw in software and vary from run to run; a threshold tight enough to catch a regression would fail on noise. The numbers are kept for comparing runs instead.

## What this gives up

- **Every change to the tree** (adding or removing a shape, changing frames) still rebuilds the tree of groups and frames and places every shape: about 12 ms of script on 10,000 shapes. Fine for edits arriving one at a time; a burst of thousands at once (a paste) is one rebuild per transaction, so it's still one rebuild.
- **Fully zoomed out, every shape is still drawn**, as a rectangle or an ellipse: 4,500 shapes on screen cost about 20 ms in software, likely much less with a GPU. Caching the zoomed-out board as one image, or drawing with WebGL (lab L8), would go further.
- **No bitmap cache for text.** Text is laid out once but drawn with `fillText` every frame. At 25%, where text is readable and many notes are on screen, that's most of the time left.
- **Benchmarks run in software rendering**, here and in CI. They show trends and relative gains; absolute numbers on real hardware will be lower.

## Alternatives considered

- **Flatbush** (static R-tree, faster to query): must be rebuilt whenever anything moves, which a drag does every frame.
- **Scanning every shape's box without a tree**: fast enough for drawing (10,000 box checks should take well under a millisecond; not measured), but hit testing would still check every shape's exact outline under the pointer. The R-tree serves both.
- **A hard frame-time gate in CI**: rejected for noise, above.
