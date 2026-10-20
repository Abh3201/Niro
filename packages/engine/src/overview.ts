import type { Shape } from "@niro/doc";
import { type Box, type Point, unionBoxes } from "./geometry";
import type { Palette } from "./render";
import type { Scene } from "./scene";
import { shapeBounds } from "./shapes";

/** One shape as the minimap draws it: a box and a color, in world units. */
export interface OverviewItem extends Box {
  readonly fill: string;
  /** Frames are drawn as faint boxes under what's in them; everything else as a solid one. */
  readonly kind: "frame" | "shape";
}

/** Everything on the board, boiled down for the minimap. */
export interface Overview {
  /** The box around every shape, or null on an empty board. */
  readonly bounds: Box | null;
  readonly items: readonly OverviewItem[];
}

const colorOf = (shape: Shape, palette: Palette): string => {
  if (shape.type === "frame") return palette.frame.border;
  if (shape.type === "sticky") return palette.paper[shape.color];
  if (shape.type === "image") return palette.solid.grey;
  return palette.solid[shape.color];
};

/** Every shape's box and color, bottom first, for drawing the whole board small. */
export function overviewOf(scene: Scene, palette: Palette): Overview {
  const items: OverviewItem[] = [];
  for (const shape of scene.ordered()) {
    // A group is drawn through what's in it.
    if (shape.type === "group") continue;
    items.push({
      ...shapeBounds(shape),
      fill: colorOf(shape, palette),
      kind: shape.type === "frame" ? "frame" : "shape",
    });
  }
  return { bounds: unionBoxes(items), items };
}

/** Where the board sits in a minimap: world `p` is at `(p - origin) * scale` in it. */
export interface OverviewFit {
  readonly scale: number;
  readonly origin: Point;
}

/**
 * How to fit `content` (the board) and `view` (what's on screen) in a
 * minimap `width` by `height`, centered, with a margin around them. The view
 * is always inside, so panning far from the shapes zooms the minimap out
 * instead of losing the view rectangle.
 */
export function fitOverview(
  content: Box | null,
  view: Box,
  width: number,
  height: number,
  margin = 6,
): OverviewFit {
  const all = unionBoxes(content ? [content, view] : [view]) as Box;
  const w = Math.max(1, all.maxX - all.minX);
  const h = Math.max(1, all.maxY - all.minY);
  const scale = Math.min((width - 2 * margin) / w, (height - 2 * margin) / h);
  return {
    scale,
    origin: {
      x: all.minX - (width / scale - w) / 2,
      y: all.minY - (height / scale - h) / 2,
    },
  };
}

/** The world point under minimap pixel `p`. */
export function overviewToWorld(fit: OverviewFit, p: Point): Point {
  return { x: p.x / fit.scale + fit.origin.x, y: p.y / fit.scale + fit.origin.y };
}

/** Minimap pixel for world point `p`. */
export function worldToOverview(fit: OverviewFit, p: Point): Point {
  return { x: (p.x - fit.origin.x) * fit.scale, y: (p.y - fit.origin.y) * fit.scale };
}
