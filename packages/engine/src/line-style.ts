import type { LineThickness, Shape } from "@niro/doc";

/** The default stroke width of a line or arrow, in world units. */
export const LINE_WIDTH = 4;

/** Stroke width of each thickness of line, in world units. Medium is the default. */
export const THICKNESS_WIDTH: Readonly<Record<LineThickness, number>> = {
  thin: 2,
  medium: LINE_WIDTH,
  thick: 8,
};

/** How wide a line or arrow is drawn. */
export const lineWidthOf = (shape: Shape): number => THICKNESS_WIDTH[shape.thickness ?? "medium"];

/** Length of an arrowhead as a multiple of the line's width; shorter lines get smaller heads. */
export const HEAD_WIDTHS = 4;
