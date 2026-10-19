import { describe, expect, it } from "vitest";
import { type DrawContext, drawScene, PLACEHOLDER_RECT } from "./render";

function recordingContext() {
  const calls: Array<{ op: string; args: number[]; fillStyle?: unknown }> = [];
  const ctx: DrawContext = {
    fillStyle: "#000000",
    clearRect: (...args: number[]) => {
      calls.push({ op: "clearRect", args });
    },
    fillRect(...args: number[]) {
      calls.push({ op: "fillRect", args, fillStyle: this.fillStyle });
    },
  };
  return { ctx, calls };
}

describe("drawScene", () => {
  it("clears the whole viewport, then draws the placeholder centered", () => {
    const { ctx, calls } = recordingContext();

    drawScene(ctx, { width: 1000, height: 800 });

    expect(calls).toEqual([
      { op: "clearRect", args: [0, 0, 1000, 800] },
      {
        op: "fillRect",
        args: [380, 320, PLACEHOLDER_RECT.width, PLACEHOLDER_RECT.height],
        fillStyle: PLACEHOLDER_RECT.color,
      },
    ]);
  });
});
