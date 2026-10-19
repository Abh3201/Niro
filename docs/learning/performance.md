# How Niro stays fast on a big board (P5)

A board with 10,000 shapes used to take about 150 ms to draw a frame: under 7 frames a second. Now panning takes about 5 ms at 100%, and 20 ms with the whole board on screen. This note covers how that was measured, what the time was going on, and the three fixes. The record of the choices is [decision 0007](../decisions/0007-rendering-performance.md).

## The budget

A 60 Hz screen shows a new frame every 16.7 ms. The browser needs some of that for its own work (input, layout, compositing), so a frame's JavaScript should finish well inside it. Taking longer doesn't slow the board down smoothly: a frame that takes 20 ms misses its slot, and the user sees the previous frame twice. That's a stutter.

## Measuring first

Guessing where time goes is usually wrong, so the first step was a benchmark: [`apps/bench`](../../apps/bench) puts the engine on a board made by `benchmarkBoard(10_000, seed)`. It has 100 frames full of sticky notes, arrows, boxes and pen scribbles, with loose shapes around them. The same seed always makes the same board, so runs can be compared. Playwright opens it and runs scenarios: panning at three zooms, zooming in and out, a note moving, notes being added, and the pointer hovering. `pnpm bench` prints a table.

Two things make timing a canvas tricky:

- **Drawing is deferred.** `fillRect` doesn't paint pixels: it records a command, and the browser rasterizes later, often on another thread or the GPU. Timing only the JavaScript misses the real cost. The benchmark forces the work to finish by reading one pixel back (`getImageData`), and counts that time too.
- **The machine matters.** Headless Chromium here and on CI draws with SwiftShader, a software GPU. Absolute numbers are pessimistic; before/after on the same machine is what counts.

For the "where", the DevTools Performance panel, or in a script the Chrome DevTools Protocol's `Profiler` domain, samples the call stack every fraction of a millisecond. Summing samples per function gives the profile. On the old engine, a third of the time was `measureText`, which was surprising, because text layouts were already cached.

## Fix 1: a cache that fits the board

The layout cache emptied itself when it reached 5,000 entries, so it wouldn't grow forever. The benchmark board has about 8,000 shapes with text. Every frame filled the cache, emptied it, and measured everything again. The cache now keeps one entry per shape, replaced when that shape's size or text changes, so its size follows the board's. A test lays out 12,000 shapes twice and checks the second pass measures nothing.

Lesson: a cache whose limit is smaller than the working set is worse than no cache, since it pays for the bookkeeping too.

## Fix 2: draw only what's on screen

At 100% the screen shows perhaps 50 of 10,000 shapes, but every shape was drawn, and the canvas clipped away the rest. Skipping them needs a fast answer to "which shapes overlap this rectangle?".

An **R-tree** answers it. It groups nearby boxes into a parent box, and nearby parents into a bigger box, up to one root. A query starts at the root and only goes into children whose box overlaps the question. Most of the board is skipped near the top, so a query costs about the logarithm of the number of shapes plus the number of answers. Niro uses [rbush](https://github.com/mourner/rbush), which also supports moving one shape at a time (a drag) and loading a whole board in one go (a page load).

Two details made it correct:

- **The box must cover everything drawn**, not just the outline: an arrowhead's wings, a pen stroke's width, a sticky note's shadow, a frame's name above it. If a box is too small, the shape vanishes at the edge of the screen while part of it should still show. The function that works the box out lives next to the drawing code, so the two change together.
- **Order comes from the scene.** The R-tree returns shapes in no particular order, but they must be drawn bottom to top. Each shape's place in the scene's ordered list is marked, and the list is then read in order.

The same index now serves hit testing and marquee selection. A property test runs random moves, deletions and frame changes on generated boards, and checks the index answers exactly what scanning every shape would.

## Fix 3: less detail when zoomed out

Fully zoomed out, almost everything is on screen, so culling doesn't help. The cost per shape has to go down instead:

- **Text too small to read isn't drawn.** Under 2.5 pixels it's skipped. Between 2.5 and 4 pixels, each line is drawn as a grey bar, which looks like text from a distance and costs one rectangle.
- **No shadow on a sticky note under 16 pixels.** It's a second rectangle per note, and at that size it's a smudge.
- **No context moves for upright shapes.** Each shape used to be drawn by `save`, `translate` to its center, draw, `restore`. For a rectangle, those calls cost more than the drawing. Upright shapes are now drawn at their position directly, and only turned shapes move the context.

This is *level of detail*, borrowed from games, where far-away models have fewer triangles.

## What's left

- Text at 25% is readable and expensive: each line is a `fillText` call every frame. Drawing each note's text once into a small image, and reusing it, would fix it. It costs memory, and the image has to be redrawn at each zoom level.
- Adding a shape rebuilds the whole tree of groups and frames: about 12 ms on 10,000 shapes. It could be updated in place.
- Fully zoomed out is 20 ms in software. WebGL (lab L8) draws thousands of rectangles in one call.
