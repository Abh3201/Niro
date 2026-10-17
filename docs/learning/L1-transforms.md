# L1: Coordinates, cameras and zooming toward the cursor

Code: [`packages/engine/src/camera.ts`](../../packages/engine/src/camera.ts), [`gestures.ts`](../../packages/engine/src/gestures.ts), [`engine.ts`](../../packages/engine/src/engine.ts).

## Three coordinate spaces

An infinite canvas juggles three spaces:

| Space | Unit | Who uses it |
|---|---|---|
| **World** | Board units. A shape at `x = 100` stays there forever. | The document, every shape |
| **Screen** | CSS pixels from the top-left of the board element | Pointer events, the zoom anchor |
| **Device** | Physical pixels in the canvas's backing store | The canvas itself |

Shapes live in world space. The mouse lives in screen space. The canvas draws in device space. Almost every bug in a whiteboard is a conversion done in the wrong order.

## The camera

Niro describes the camera with three numbers:

- `x`, `y`: the world point shown at the top-left corner of the screen
- `zoom`: how many screen pixels one world unit covers

From that, the two conversions are:

```
screen = (world - camera) * zoom
world  = screen / zoom + camera
```

Check it: at `zoom = 2` with the camera at `(10, 20)`, the world point `(11, 20)` is one unit right of the corner, so it's 2 screen pixels right: `(11 - 10) * 2 = 2`. ✓

Why top-left rather than center? It makes both formulas one line, and the viewport size never appears in them. "Center the board" is a separate helper (`centerOn`) that does need the viewport.

## Panning

Dragging should make the content follow the pointer exactly. If the pointer moves `dx` screen pixels, the content must move `dx` screen pixels, which is `dx / zoom` world units. The camera moves the *opposite* way, because moving the camera right moves the content left:

```
camera.x -= dx / zoom
```

Forget the `/ zoom` and panning feels fine at 100% but drifts at every other zoom level. The property test `panBy moves content by exactly the pointer distance at any zoom` exists to catch exactly that.

## Zooming toward the cursor

This is the one worth deriving by hand. Naive zoom (just change `zoom`) zooms toward the top-left corner, because that's the point the camera is pinned to. Users expect the point under the cursor to stay under the cursor.

Let `s` be the cursor in screen space, `z0` and `c0` the zoom and camera before, `z1` the new zoom. The world point under the cursor is:

```
w = s / z0 + c0
```

After zooming, that same world point must still be under `s`:

```
s / z1 + c1 = w
         c1 = w - s / z1
```

That's all of `zoomAt`. It's three lines, and the property test proves the anchor holds for any camera, cursor and zoom within limits.

## The same thing as matrices

Every conversion above is an affine transform. World to screen is "translate by `-camera`, then scale by `zoom`":

```
[ zoom   0     -camera.x * zoom ]
[ 0      zoom  -camera.y * zoom ]
[ 0      0      1               ]
```

The Canvas 2D API takes exactly these six numbers: `ctx.setTransform(a, b, c, d, e, f)` is the matrix `[a c e; b d f; 0 0 1]`. So drawing shapes in world coordinates is one call, and every `fillRect` after it is in world units:

```ts
const scale = pixelRatio * camera.zoom;
ctx.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);
```

Notice `pixelRatio` in there. That's the third space.

## HiDPI: the device pixel ratio

A canvas has two sizes. Its CSS size is how big it looks. Its backing store (`canvas.width`, `canvas.height`) is how many pixels it holds. On a 2x screen a 400px-wide canvas needs an 800px backing store, or the browser stretches 400 pixels across 800 physical ones and everything goes blurry.

So the full pipeline is world → screen (camera) → device (pixel ratio), and the matrix is their product: scale by `zoom * pixelRatio`. The background grid is drawn in screen space instead (scale by `pixelRatio` only), so dots stay the same crisp size at every zoom.

Two gotchas the engine handles:

- Setting `canvas.width` clears the canvas *and* resets the context's transform and styles, so only assign it when the size actually changes.
- Dragging a window to a monitor with a different pixel ratio doesn't resize the element, so `ResizeObserver` never fires. The engine also watches `matchMedia("(resolution: Ndppx)")`.

## Pinch with two fingers

A pinch does two things at once: the change in finger spread is a zoom, and the movement of the midpoint is a pan. Done in that order, zooming at the *old* midpoint and then panning by the midpoint's movement, the world point between your fingers stays between your fingers (`gestures.test.ts` checks this with random finger positions).

## Wheel events are a mess

- A mouse wheel sends large `deltaY` jumps. A trackpad sends many small ones.
- A trackpad *pinch* arrives as a wheel event with `ctrlKey` set, even though you didn't press ctrl. That's why ctrl + wheel means zoom.
- `deltaMode` can be pixels (0), lines (1) or pages (2). Firefox sometimes uses lines.
- Safari also sends its own `gesturestart` / `gesturechange` events with a `scale` property.

Niro turns `deltaY` into a zoom factor with `exp(-delta * 0.01)`. The exponential has a nice property: zooming in by some amount and back out by the same amount returns exactly to where you started, because `exp(a) * exp(-a) = 1`.

## Rendering only when something changed

A game redraws 60 times a second whether or not anything moved. A whiteboard shouldn't: it's open in a tab all day, and a busy loop drains laptop batteries. The engine keeps a dirty flag per layer, and `requestAnimationFrame` is only requested when something is marked dirty. The browser test `does no work while idle` counts animation frame requests over a second of idleness and expects zero.

## Try it yourself

1. Remove `/ camera.zoom` from `panBy` and run `pnpm test`. Which property fails, and what input does fast-check shrink it to?
2. Change `zoomAt` to keep the camera fixed (just set `zoom`). Zoom in the app: which point stays still?
3. Why does `wheelZoomFactor` clamp the delta to ±100? Try a mouse with a big wheel step without the clamp.
4. Work out by hand where the world origin appears on screen with camera `(-500, -300, 2)`. Check it with `worldToScreen`.
