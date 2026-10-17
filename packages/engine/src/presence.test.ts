import type { ShapeId } from "@niro/doc";
import { describe, expect, it } from "vitest";
import type { Point } from "./geometry";
import { CURSOR_SMOOTHING_MS, type RemotePeer, SmoothedCursors } from "./presence";

const peer = (id: number, cursor: Point | null): RemotePeer => ({
  id,
  name: `peer ${id}`,
  color: "#123456",
  cursor,
  selection: [] as ShapeId[],
});

describe("SmoothedCursors", () => {
  it("shows a new cursor where it is, without sliding in", () => {
    const cursors = new SmoothedCursors();
    cursors.retarget([peer(1, { x: 100, y: 50 })]);
    expect(cursors.position(1)).toEqual({ x: 100, y: 50 });
    expect(cursors.step(16, 0.1)).toBe(false);
  });

  it("eases toward a new position", () => {
    const cursors = new SmoothedCursors();
    cursors.retarget([peer(1, { x: 0, y: 0 })]);
    cursors.retarget([peer(1, { x: 100, y: 0 })]);

    expect(cursors.step(CURSOR_SMOOTHING_MS, 0.1)).toBe(true);
    expect(cursors.position(1)?.x).toBeCloseTo(100 * (1 - Math.exp(-1)), 6);

    // Steps compose: two half steps land where one whole step would.
    const halves = new SmoothedCursors();
    halves.retarget([peer(1, { x: 0, y: 0 })]);
    halves.retarget([peer(1, { x: 100, y: 0 })]);
    halves.step(CURSOR_SMOOTHING_MS / 2, 0.1);
    halves.step(CURSOR_SMOOTHING_MS / 2, 0.1);
    expect(halves.position(1)?.x).toBeCloseTo(cursors.position(1)?.x ?? Number.NaN, 6);
  });

  it("lands on the target and stops asking for frames", () => {
    const cursors = new SmoothedCursors();
    cursors.retarget([peer(1, { x: 0, y: 0 })]);
    cursors.retarget([peer(1, { x: 1000, y: -500 })]);
    let frames = 0;
    while (cursors.step(16, 0.25)) frames++;
    expect(cursors.position(1)).toEqual({ x: 1000, y: -500 });
    // ln(1118 / 0.25) * 60 ms ≈ 505 ms of 16 ms frames.
    expect(frames).toBeGreaterThan(20);
    expect(frames).toBeLessThan(40);
  });

  it("drops peers that left or moved off the board, and re-shows them without sliding", () => {
    const cursors = new SmoothedCursors();
    cursors.retarget([peer(1, { x: 0, y: 0 }), peer(2, { x: 5, y: 5 })]);
    cursors.retarget([peer(1, null)]);
    expect(cursors.position(1)).toBeUndefined();
    expect(cursors.position(2)).toBeUndefined();

    cursors.retarget([peer(1, { x: 300, y: 300 })]);
    expect(cursors.position(1)).toEqual({ x: 300, y: 300 });
  });
});
