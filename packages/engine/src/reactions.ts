import { REACTION_NAMES, REACTIONS, type ReactionName, type Shape } from "@niro/doc";
import type { Box } from "./geometry";
import { shapeBounds } from "./shapes";

/**
 * Emoji reactions, drawn as a row of pills under a shape: one per reaction,
 * with how many people gave it. Sizes are in world units, so the row grows
 * and shrinks with the shape as the board zooms.
 */

/** Height of a pill, the gap above the row, and between pills. */
export const PILL_HEIGHT = 24;
const GAP = 6;
const EMOJI_SIZE = 14;
/** A pill is this wide, plus `DIGIT_WIDTH` for each digit of its count. */
const PILL_BASE_WIDTH = 32;
const DIGIT_WIDTH = 8;
/** Below this height on screen, in CSS pixels, the row isn't drawn: it would be a smudge. */
const HIDE_BELOW_PX = 6;

export interface Pill {
  readonly reaction: ReactionName;
  readonly count: number;
  readonly box: Box;
}

/** Where each of the shape's reactions is drawn; none when it has none. */
export function reactionPills(shape: Shape): Pill[] {
  const reactions = shape.reactions;
  if (!reactions) return [];
  const bounds = shapeBounds(shape);
  const top = bounds.maxY + GAP;
  let left = bounds.minX;
  const pills: Pill[] = [];
  for (const reaction of REACTION_NAMES) {
    const count = reactions[reaction]?.length ?? 0;
    if (count === 0) continue;
    const width = PILL_BASE_WIDTH + DIGIT_WIDTH * String(count).length;
    pills.push({
      reaction,
      count,
      box: { minX: left, minY: top, maxX: left + width, maxY: top + PILL_HEIGHT },
    });
    left += width + GAP;
  }
  return pills;
}

/** The box around a shape's reactions, or null when it has none. */
export function reactionsExtent(shape: Shape): Box | null {
  const pills = reactionPills(shape);
  const first = pills[0];
  const last = pills[pills.length - 1];
  if (!first || !last) return null;
  return { minX: first.box.minX, minY: first.box.minY, maxX: last.box.maxX, maxY: last.box.maxY };
}

export interface PillColors {
  readonly fill: string;
  readonly border: string;
  readonly text: string;
}

/** Draws the shape's reactions. Expects the context in world coordinates. */
export function drawReactions(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  colors: PillColors,
  zoom: number,
): void {
  if (PILL_HEIGHT * zoom < HIDE_BELOW_PX) return;
  const pills = reactionPills(shape);
  if (pills.length === 0) return;
  ctx.lineWidth = 1;
  // Alphabetic, which SVG export draws the same way.
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (const { reaction, count, box } of pills) {
    const w = box.maxX - box.minX;
    roundedRect(ctx, box.minX, box.minY, w, PILL_HEIGHT, PILL_HEIGHT / 2);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.strokeStyle = colors.border;
    ctx.stroke();
    const baseline = box.minY + PILL_HEIGHT / 2 + 5;
    ctx.font = `${EMOJI_SIZE}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillStyle = colors.text;
    ctx.fillText(REACTIONS[reaction], box.minX + 7, baseline);
    ctx.font = `600 12px system-ui, sans-serif`;
    ctx.fillText(String(count), box.minX + 7 + EMOJI_SIZE + 5, baseline - 0.5);
  }
}

/** A rounded rectangle path, from the calls `SvgContext` has too. */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
