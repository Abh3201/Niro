import type { ShapeId } from "@niro/doc";
import type { View } from "./follow";
import type { Scene } from "./scene";
import { shapeExtent } from "./shapes";

/**
 * The slides of a presentation are the board's frames, in reading order:
 * top to bottom in rows, left to right within a row. A frame inside another
 * frame is part of that slide, not a slide of its own.
 *
 * A row is the frames whose tops are within half the first one's height of
 * it, so a row of frames dragged a little out of line still reads as one.
 */
export function presentationOrder(scene: Scene): ShapeId[] {
  const frames = scene
    .ordered()
    .filter((shape) => shape.type === "frame" && scene.framesAround(shape.id).length === 0)
    .map((shape) => ({ id: shape.id, top: shape.y, left: shape.x, height: shape.h }));
  frames.sort((a, b) => a.top - b.top || a.left - b.left || (a.id < b.id ? -1 : 1));
  const rows: Array<typeof frames> = [];
  for (const frame of frames) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (row && first && frame.top < first.top + first.height / 2) row.push(frame);
    else rows.push([frame]);
  }
  return rows.flatMap((row) =>
    row.sort((a, b) => a.left - b.left || (a.id < b.id ? -1 : 1)).map((f) => f.id),
  );
}

/** Space left around a slide, as a share of its size on each side. */
const SLIDE_MARGIN = 0.06;

/** What a slide shows: its frame, name included, with a little room around it. */
export function slideView(scene: Scene, id: ShapeId): View | null {
  const shape = scene.get(id);
  if (!shape) return null;
  const box = shapeExtent(shape);
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const padX = w * SLIDE_MARGIN;
  const padY = h * SLIDE_MARGIN;
  return { x: box.minX - padX, y: box.minY - padY, w: w + 2 * padX, h: h + 2 * padY };
}
