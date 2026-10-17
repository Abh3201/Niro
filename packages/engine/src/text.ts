import type { Shape, ShapePatch } from "@niro/doc";
import type { Palette } from "./render";

/**
 * Text inside shapes: where it goes, how it wraps, and how big it is.
 *
 * Canvas has no text layout: `fillText` draws one line wherever it's told.
 * So lines are broken here, by measuring. Widths scale with font size, so
 * each string is measured once, at a reference size, and every size after
 * that is arithmetic. That is what makes fitting text to a sticky note (try
 * a size, wrap, see if it fits, try again) cheap enough to redo on every
 * keystroke.
 */

export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Line spacing, as a multiple of the font size. The editor uses the same. */
export const LINE_HEIGHT = 1.25;
/** Font size of text shapes, in world units. */
export const TEXT_FONT_SIZE = 24;
/** Font size of a frame's name, written above its top-left corner, in world units. */
export const FRAME_LABEL_SIZE = 14;
/** Space between a frame's name and its top edge, in world units. */
export const FRAME_LABEL_GAP = 6;
/** Height of the strip above a frame where its name's last line is: where a click picks the frame. */
export const FRAME_LABEL_HEIGHT = FRAME_LABEL_SIZE * LINE_HEIGHT + FRAME_LABEL_GAP;
/** Width a text shape gets when it's created with a click. */
export const DEFAULT_TEXT_WIDTH = 240;
/** Most characters the editor takes in one shape: a board is for notes, not novels. */
export const MAX_TEXT_LENGTH = 10_000;
/** Ink on sticky notes, whose paper is light in both themes. */
const STICKY_INK = "#1e1e24";
const LIGHT_INK = "#ffffff";

/** Width of `text` set at a font size of 1, in the same units as the font size. */
export type MeasureText = (text: string) => number;

export interface TextLayout {
  readonly fontSize: number;
  readonly lines: readonly string[];
  /** Width of each line at `fontSize`, without the spaces it ends with. */
  readonly widths: readonly number[];
  readonly align: "left" | "center";
  /**
   * Where the lines go, in the shape's own frame (origin at its center, axes
   * along its sides, before rotation): the top-left corner of the first
   * line and the width lines wrap at. The lines take `textHeight(lines.length,
   * fontSize)` from there.
   */
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/**
 * Breaks `text` into lines no wider than `maxWidth` at `fontSize`: at
 * newlines, then at spaces, and inside words only when one word is too wide
 * on its own. Like a browser does with `white-space: pre-wrap`, which the
 * editor uses: spaces are kept, and spaces at the end of a line never push
 * it onto the next one.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: MeasureText,
): string[] {
  const width = (s: string) => measure(s) * fontSize;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line: string | null = null;
    for (const word of paragraph.split(" ")) {
      if (line !== null) {
        const candidate: string = `${line} ${word}`;
        // An empty word is a space after a space: it hangs off the line's end.
        if (word === "" || width(candidate) <= maxWidth) {
          line = candidate;
          continue;
        }
        lines.push(line);
      }
      line = word;
      // A word too long for a line on its own breaks between characters.
      while (width(line) > maxWidth) {
        const fit = fittingPrefix(line, maxWidth, width);
        if (fit >= line.length) break; // one character, wider than the line
        lines.push(line.slice(0, fit));
        line = line.slice(fit);
      }
    }
    lines.push(line ?? "");
  }
  return lines;
}

/** Length of the longest start of `word` that fits, at least one character and never half of a surrogate pair. */
function fittingPrefix(word: string, maxWidth: number, width: (s: string) => number): number {
  // Widths grow with length, so binary search.
  let lo = 1;
  let hi = word.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(word.slice(0, mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (isHighSurrogate(word.charCodeAt(lo - 1))) lo += lo === 1 ? 1 : -1;
  return lo;
}

export const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
export const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Height `lines` lines take at `fontSize`. */
export const textHeight = (lines: number, fontSize: number) => lines * fontSize * LINE_HEIGHT;

/** Smallest font a shape's text shrinks to, in world units. */
const MIN_FIT_SIZE = 1;
/** Steps of the search for the largest font that fits: precise to well under 1%. */
const FIT_STEPS = 12;

/**
 * Lays out a shape's text. Sticky notes, rectangles and ellipses center it
 * and shrink it until it fits; text shapes wrap it at their width, at one
 * size, and grow downward to hold it (see `fittedTextHeight`).
 */
export function layoutText(shape: Shape, measure: MeasureText): TextLayout {
  const { w, h, text } = shape;
  if (shape.type === "frame") {
    // A frame's name sits above it, growing upward if it wraps.
    const lines = wrapText(text, w, FRAME_LABEL_SIZE, measure);
    return {
      fontSize: FRAME_LABEL_SIZE,
      lines,
      widths: lineWidths(lines, FRAME_LABEL_SIZE, measure),
      align: "left",
      x: -w / 2,
      y: -h / 2 - FRAME_LABEL_GAP - textHeight(lines.length, FRAME_LABEL_SIZE),
      width: w,
    };
  }
  if (shape.type === "text") {
    const lines = wrapText(text, w, TEXT_FONT_SIZE, measure);
    return {
      fontSize: TEXT_FONT_SIZE,
      lines,
      widths: lineWidths(lines, TEXT_FONT_SIZE, measure),
      align: "left",
      x: -w / 2,
      y: -h / 2,
      width: w,
    };
  }
  // An ellipse's text goes in the largest rectangle of the same proportions inside it.
  const inset = shape.type === "ellipse" ? Math.SQRT1_2 : 1;
  const padding = Math.min(w, h) * 0.08;
  const boxW = Math.max(1, w * inset - 2 * padding);
  const boxH = Math.max(1, h * inset - 2 * padding);
  const largest = Math.min(64, Math.max(12, Math.min(w, h) * 0.12));

  const fits = (size: number) =>
    textHeight(wrapText(text, boxW, size, measure).length, size) <= boxH;
  let fontSize = largest;
  if (!fits(largest)) {
    let lo = MIN_FIT_SIZE;
    let hi = largest;
    for (let i = 0; i < FIT_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    fontSize = lo;
  }
  const lines = wrapText(text, boxW, fontSize, measure);
  return {
    fontSize,
    lines,
    widths: lineWidths(lines, fontSize, measure),
    align: "center",
    x: -boxW / 2,
    y: -textHeight(lines.length, fontSize) / 2,
    width: boxW,
  };
}

const lineWidths = (lines: readonly string[], fontSize: number, measure: MeasureText) =>
  lines.map((line) => measure(line.trimEnd()) * fontSize);

/** The height a text shape needs for its text: one line at least. */
export function fittedTextHeight(shape: Shape, measure: MeasureText): number {
  const lines = wrapText(shape.text, shape.w, TEXT_FONT_SIZE, measure).length;
  return textHeight(Math.max(1, lines), TEXT_FONT_SIZE);
}

/**
 * The change that gives a box shape height `h` with its top edge where it
 * is (along its own axes, when it's rotated), or null when it has that height.
 */
export function withHeight(shape: Shape, h: number): ShapePatch | null {
  const dh = h - shape.h;
  if (dh === 0) return null;
  // The center moves along the shape's own y axis, (-sin, cos), by dh / 2.
  const cx = shape.x + shape.w / 2 - (Math.sin(shape.rotation) * dh) / 2;
  const cy = shape.y + shape.h / 2 + (Math.cos(shape.rotation) * dh) / 2;
  return { x: cx - shape.w / 2, y: cy - h / 2, h };
}

/** Color of a shape's text: dark or white on solid fills, whichever stands out more. */
export function inkColor(shape: Shape, palette: Palette): string {
  if (shape.type === "sticky") return STICKY_INK;
  if (shape.type === "frame") return palette.frame.label;
  if (shape.type === "text") return palette.solid[shape.color];
  const fill = palette.solid[shape.color];
  return contrast(fill, STICKY_INK) >= contrast(fill, LIGHT_INK) ? STICKY_INK : LIGHT_INK;
}

/** WCAG contrast ratio between two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export interface FontMetrics {
  readonly measure: MeasureText;
  /**
   * Distance from the top of a line to its baseline, as a multiple of the
   * font size: where a browser puts it in a line box `LINE_HEIGHT` tall, so
   * canvas text sits exactly where the editor's text did.
   */
  readonly baseline: number;
}

/** Measures with a canvas at a 100px reference size, remembering each string. */
export function canvasFontMetrics(): FontMetrics {
  const REFERENCE = 100;
  const ctx = document.createElement("canvas").getContext("2d");
  const widths = new Map<string, number>();
  let ascent = 0.9;
  let descent = 0.22;
  if (ctx) {
    ctx.font = `${REFERENCE}px ${FONT_FAMILY}`;
    const m = ctx.measureText("Hg");
    // The font's own ascent and descent, which CSS uses for a line's content area.
    if (m.fontBoundingBoxAscent > 0) {
      ascent = m.fontBoundingBoxAscent / REFERENCE;
      descent = m.fontBoundingBoxDescent / REFERENCE;
    }
  }
  return {
    measure(text) {
      let width = widths.get(text);
      if (width === undefined) {
        // Without a 2D context, guess: about half an em per character.
        width = ctx ? ctx.measureText(text).width / REFERENCE : text.length * 0.5;
        if (widths.size >= 20_000) widths.clear();
        widths.set(text, width);
      }
      return width;
    },
    // CSS centers the content area (ascent + descent) in the line box.
    baseline: (LINE_HEIGHT - ascent - descent) / 2 + ascent,
  };
}

/** Remembers layouts by shape size and text, so a frame that changed nothing measures nothing. */
export class TextLayouts {
  private readonly cache = new Map<string, TextLayout>();

  constructor(private readonly measure: MeasureText) {}

  get(shape: Shape): TextLayout {
    const key = `${shape.type}|${shape.w}|${shape.h}|${shape.text}`;
    let layout = this.cache.get(key);
    if (!layout) {
      layout = layoutText(shape, this.measure);
      if (this.cache.size >= 5_000) this.cache.clear();
      this.cache.set(key, layout);
    }
    return layout;
  }

  fittedHeight(shape: Shape): number {
    return fittedTextHeight(shape, this.measure);
  }
}
