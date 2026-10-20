# 0010: Elbow arrows are a route setting; the path is derived

- Status: accepted
- Date: 2026-10-20
- Code: [`packages/engine/src/elbow.ts`](../../packages/engine/src/elbow.ts), [`packages/engine/src/arrows.ts`](../../packages/engine/src/arrows.ts), [`packages/doc/src/shape.ts`](../../packages/doc/src/shape.ts)

## Decision

- An arrow has an optional `route`: `straight` (default, not stored) or `elbow`. Board format version 8.
- **The bent path is never stored.** It is computed from the two ends and the shapes they attach to, by a shortest-path search over a small grid of lines through the shapes' edges, with a penalty per bend. The result is cached per drawn shape and recomputed when an end or an attached shape changes.
- An end attached to a shape leaves from the side facing the other end, a small gap outside the shape. An unattached end is routed to as a bare point.
- If no route is found, the arrow falls back to a three-segment Z path.

## Why

- Stored waypoints would be a second source of truth that two people moving the same shapes could disagree on. A derived path converges as soon as the shapes do, with no merge rule.
- Existing code that reads an arrow's line (hit testing, marquee, bounds, drawing, SVG export) takes a list of points, so one function (`linePoints`) serves both routes.

## What this gives up

- **Only the shapes an arrow is attached to are routed around.** Other shapes in the way are crossed.
- No dragging of the middle segment: the route is automatic.
- **Older clients** (schema 7) draw an elbow arrow straight between its ends and are held read-only after the version bump.
