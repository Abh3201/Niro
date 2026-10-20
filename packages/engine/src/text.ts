import {
  type ColorName,
  defaultAlign,
  type FontName,
  hasTextColor,
  marksAt,
  type Shape,
  type ShapeId,
  type ShapePatch,
  type TextAlign,
  type TextMarks,
  type TextRun,
  takesTextStyle,
} from "@niro/doc";
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
 *
 * That arithmetic only holds if text is also drawn at the reference size,
 * scaled down. Widths don't scale with font size: fonts with optical sizes,
 * like the system font on macOS (SF Pro), switch to wider letters at small
 * sizes, so 20px text set as wide as `measure` said was ~10% wider on screen
 * and ran out of its shape. Drawing at `MEASURE_SIZE` and scaling makes the
 * drawn width the measured one, whatever the font does.
 *
 * Parts of a text can be formatted differently (`Shape.textRuns`): a line
 * is then made of pieces, each in one font and size, and lines are as tall
 * as their biggest piece, as a browser sets them.
 */

export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/**
 * The font lists each typeface name stands for. Hand is Kalam, a free
 * (SIL Open Font License) handwriting font the web app serves itself, so
 * it looks the same everywhere; the rest are fonts already installed on
 * Windows, macOS and most Linux desktops. Each ends in a generic family.
 */
export const FONT_FAMILIES: Record<FontName, string> = {
  sans: FONT_FAMILY,
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  hand: 'Kalam, "Comic Sans MS", "Chalkboard SE", cursive',
};
/** The font new notes, shapes and text are written in. */
export const NEW_TEXT_FONT: FontName = "hand";
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
/** Font size, in pixels, text is measured, drawn and edited at, then scaled to its real size. */
export const MEASURE_SIZE = 100;
/** Width a text shape gets when it's created with a click. */
export const DEFAULT_TEXT_WIDTH = 240;
/** Most characters the editor takes in one shape: a board is for notes, not novels. */
export const MAX_TEXT_LENGTH = 10_000;
/** Ink on sticky notes, whose paper is light in both themes. */
const STICKY_INK = "#1e1e24";
const LIGHT_INK = "#ffffff";

/** The CSS font for `MEASURE_SIZE` text with no formatting. */
export const DEFAULT_FONT = `${MEASURE_SIZE}px ${FONT_FAMILY}`;
/**
 * Where the baseline sits in a line `LINE_HEIGHT` tall, as a multiple of
 * the font size, for a font with typical ascent (0.9) and descent (0.22):
 * what layouts use when no real font metrics are at hand (tests).
 */
const TYPICAL_BASELINE = (LINE_HEIGHT - 0.9 - 0.22) / 2 + 0.9;

/**
 * Width of `text` set at a font size of 1, in the same units as the font
 * size, in `font`: a CSS font at `MEASURE_SIZE` (see `cssFont`), plain
 * text when absent.
 */
export type MeasureText = (text: string, font?: string) => number;
/** `FontMetrics.baseline`. */
export type BaselineOf = (font: string) => number;

/** The CSS font, at `MEASURE_SIZE`, for a typeface, weight and slant. */
export function fontOf(family: FontName, bold: boolean, italic: boolean): string {
  if (family === "sans" && !bold && !italic) return DEFAULT_FONT;
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${MEASURE_SIZE}px ${FONT_FAMILIES[family]}`;
}

/** The CSS font a shape's unformatted text is measured, drawn and edited in, at `MEASURE_SIZE`. */
export function cssFont(shape: Shape): string {
  if (!takesTextStyle(shape.type)) return DEFAULT_FONT;
  return fontOf(shape.font ?? "sans", shape.bold === true, shape.italic === true);
}

/** The size set for a shape's text, or null for automatic. */
const setSize = (shape: Shape): number | null =>
  typeof shape.fontSize === "number" && takesTextStyle(shape.type) ? shape.fontSize : null;

/** How some characters are drawn: the shape's settings with their marks over them. */
export interface PieceStyle {
  /** CSS font at `MEASURE_SIZE`. */
  readonly font: string;
  readonly family: FontName;
  readonly bold: boolean;
  readonly italic: boolean;
  /** World units, as drawn (after any shrinking to fit). */
  readonly size: number;
  readonly underline: boolean;
  readonly strike: boolean;
  /** A color set on these characters, or null for the shape's (see `inkColor`). */
  readonly color: ColorName | null;
}

/** Part of a line in one style. */
export interface TextPiece {
  readonly text: string;
  /** Where it starts in the shape's text. */
  readonly start: number;
  /** From the line's left end. */
  readonly x: number;
  /** Without the spaces a line ends with. */
  readonly width: number;
  readonly style: PieceStyle;
}

/** One line as drawn. */
export interface TextLine {
  readonly text: string;
  /** Where it starts in the shape's text. */
  readonly start: number;
  /** Without the spaces it ends with. */
  readonly width: number;
  /** From the top of the text. */
  readonly top: number;
  readonly height: number;
  /** From the line's top to its baseline. */
  readonly baseline: number;
  readonly align: TextAlign;
  /** In order; none on an empty line. */
  readonly pieces: readonly TextPiece[];
  /** The style an empty line, or the end of the line, is in: what typing there would look like. */
  readonly style: PieceStyle;
}

export interface TextLayout {
  /** Size of the shape's unformatted text, as drawn (after any shrinking to fit). */
  readonly fontSize: number;
  /** How much a box's text was shrunk to fit: 1 when it wasn't. Formatted sizes are multiplied by it too. */
  readonly scale: number;
  readonly lines: readonly string[];
  /** Width of each line, without the spaces it ends with. */
  readonly widths: readonly number[];
  readonly rows: readonly TextLine[];
  /** All the lines' height. */
  readonly height: number;
  /** How a paragraph with no alignment of its own is aligned. */
  readonly align: TextAlign;
  /** The CSS font of the shape's unformatted text, at `MEASURE_SIZE` (see `cssFont`). */
  readonly font: string;
  /**
   * Where the lines go, in the shape's own frame (origin at its center, axes
   * along its sides, before rotation): the top-left corner of the first
   * line and the width lines wrap at. The lines take `height` from there.
   */
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/**
 * Breaks a paragraph, `text` from `start` to `end`, into lines no wider
 * than `maxWidth`, as `[start, end)` pairs: at spaces, and inside words
 * only when one word is too wide on its own. Like a browser does with
 * `white-space: pre-wrap`, which the editor uses: spaces are kept, and
 * spaces at the end of a line never push it onto the next one. `width`
 * measures `text` from one position to another.
 */
function wrapParagraph(
  text: string,
  start: number,
  end: number,
  maxWidth: number,
  width: (from: number, to: number) => number,
): Array<[number, number]> {
  const lines: Array<[number, number]> = [];
  let line: [number, number] | null = null;
  let wordStart = start;
  while (wordStart <= end) {
    const space = text.indexOf(" ", wordStart);
    const wordEnd = space === -1 || space > end ? end : space;
    if (line !== null) {
      // An empty word is a space after a space: it hangs off the line's end.
      if (wordEnd === wordStart || width(line[0], wordEnd) <= maxWidth) {
        line = [line[0], wordEnd];
        wordStart = wordEnd + 1;
        continue;
      }
      lines.push(line);
    }
    line = [wordStart, wordEnd];
    // A word too long for a line on its own breaks between characters.
    while (width(line[0], line[1]) > maxWidth) {
      const fit = fittingPrefix(text, line[0], line[1], maxWidth, width);
      if (fit >= line[1] - line[0]) break; // one character, wider than the line
      lines.push([line[0], line[0] + fit]);
      line = [line[0] + fit, line[1]];
    }
    wordStart = wordEnd + 1;
  }
  lines.push(line ?? [start, start]);
  return lines;
}

/**
 * Breaks `text` into lines no wider than `maxWidth` at `fontSize`: at
 * newlines, then as `wrapParagraph` does.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: (text: string) => number,
): string[] {
  const width = (from: number, to: number) => measure(text.slice(from, to)) * fontSize;
  const lines: string[] = [];
  let start = 0;
  for (const paragraph of text.split("\n")) {
    const end = start + paragraph.length;
    for (const [a, b] of wrapParagraph(text, start, end, maxWidth, width))
      lines.push(text.slice(a, b));
    start = end + 1;
  }
  return lines;
}

/** How many characters from `start` fit: at least one, and never half of a surrogate pair. */
function fittingPrefix(
  text: string,
  start: number,
  end: number,
  maxWidth: number,
  width: (from: number, to: number) => number,
): number {
  // Widths grow with length, so binary search.
  let lo = 1;
  let hi = end - start - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(start, start + mid) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (isHighSurrogate(text.charCodeAt(start + lo - 1))) lo += lo === 1 ? 1 : -1;
  return lo;
}

export const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
export const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Height `lines` lines take at `fontSize`, all in one size. */
export const textHeight = (lines: number, fontSize: number) => lines * fontSize * LINE_HEIGHT;

/** Smallest font a shape's text shrinks to, in world units. */
const MIN_FIT_SIZE = 1;
/** Steps of the search for the largest font that fits: precise to well under 1%. */
const FIT_STEPS = 12;

/** A stretch of text in one style. */
interface Segment {
  readonly start: number;
  readonly end: number;
  readonly marks: TextMarks;
}

/** The text cut where its marks change: one segment for unformatted text. */
function segmentsOf(text: string, runs: readonly TextRun[] | undefined): Segment[] {
  if (!runs) return [{ start: 0, end: text.length, marks: {} }];
  const segments: Segment[] = [];
  let at = 0;
  for (const run of runs) {
    segments.push({ start: at, end: at + run.length, marks: run.marks });
    at += run.length;
  }
  return segments;
}

/** What a shape's text, or some of it, is set in when nothing else is said. */
interface Defaults {
  readonly family: FontName;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  /** Before shrinking to fit. */
  readonly size: number;
}

function defaultsOf(shape: Shape, size: number): Defaults {
  const styled = takesTextStyle(shape.type);
  return {
    family: styled ? (shape.font ?? "sans") : "sans",
    bold: styled && shape.bold === true,
    italic: styled && shape.italic === true,
    underline: styled && shape.underline === true,
    strike: styled && shape.strike === true,
    size,
  };
}

function styleOf(defaults: Defaults, marks: TextMarks, scale: number): PieceStyle {
  const family = marks.font ?? defaults.family;
  const bold = marks.bold ?? defaults.bold;
  const italic = marks.italic ?? defaults.italic;
  return {
    font: fontOf(family, bold, italic),
    family,
    bold,
    italic,
    size: (marks.size ?? defaults.size) * scale,
    underline: marks.underline ?? defaults.underline,
    strike: marks.strike ?? defaults.strike,
    color: marks.color ?? null,
  };
}

/**
 * Lines for `text` with every size multiplied by `scale`, wrapped at
 * `maxWidth`. Paragraphs are aligned as the line break that ends them
 * says, or else as `align`.
 */
function setLines(
  text: string,
  segments: readonly Segment[],
  defaults: Defaults,
  scale: number,
  maxWidth: number,
  align: TextAlign,
  measure: MeasureText,
  baselineOf: BaselineOf,
): { rows: TextLine[]; height: number } {
  const styles = segments.map((segment) => styleOf(defaults, segment.marks, scale));
  // The segment holding character `i` (the last one past the end).
  const segmentAt = (i: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((segments[mid] as Segment).start <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const width = (from: number, to: number): number => {
    let total = 0;
    for (let k = segmentAt(from); k < segments.length && from < to; k++) {
      const segment = segments[k] as Segment;
      const style = styles[k] as PieceStyle;
      const until = Math.min(to, segment.end);
      if (until > from) total += measure(text.slice(from, until), style.font) * style.size;
      from = Math.max(from, until);
    }
    return total;
  };
  const rows: TextLine[] = [];
  let top = 0;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const paragraphAlign =
      (newline === -1 ? undefined : segments[segmentAt(newline)]?.marks.align) ?? align;
    for (const [a, b] of wrapParagraph(text, start, end, maxWidth, width)) {
      let trimmed = b;
      while (trimmed > a && text[trimmed - 1] === " ") trimmed--;
      const pieces: TextPiece[] = [];
      let x = 0;
      for (let k = segmentAt(a); k < segments.length; k++) {
        const segment = segments[k] as Segment;
        const from = Math.max(a, segment.start);
        const to = Math.min(b, segment.end);
        if (from >= b) break;
        if (to <= from) continue;
        const style = styles[k] as PieceStyle;
        const piece = text.slice(from, to);
        const full = measure(piece, style.font) * style.size;
        const shown = to > trimmed ? width(from, Math.max(from, trimmed)) : full;
        pieces.push({ text: piece, start: from, x, width: shown, style });
        x += full;
      }
      // An empty line is as tall as what's typed there would be: like the
      // line break that ends it, or the one before it.
      const at = a < text.length ? a : Math.max(0, a - 1);
      const style =
        pieces.length > 0
          ? (pieces[pieces.length - 1] as TextPiece).style
          : (styles[segmentAt(at)] as PieceStyle);
      const used = pieces.length > 0 ? pieces.map((piece) => piece.style) : [style];
      // As CSS sets an inline box: each font's content area centered in its
      // own line height, all on one baseline.
      let above = 0;
      let below = 0;
      for (const s of used) {
        const baseline = baselineOf(s.font);
        above = Math.max(above, baseline * s.size);
        below = Math.max(below, (LINE_HEIGHT - baseline) * s.size);
      }
      rows.push({
        text: text.slice(a, b),
        start: a,
        width: width(a, trimmed),
        top,
        height: above + below,
        baseline: above,
        align: paragraphAlign,
        pieces,
        style,
      });
      top += above + below;
    }
    start = end + 1;
  }
  return { rows, height: top };
}

/**
 * Lays out a shape's text. Sticky notes, rectangles and ellipses shrink it
 * until it fits (every size by the same factor); text shapes wrap it at
 * their width and grow downward to hold it (see `fittedTextHeight`).
 */
export function layoutText(
  shape: Shape,
  measure: MeasureText,
  baselineOf: BaselineOf = () => TYPICAL_BASELINE,
): TextLayout {
  const { w, h, text } = shape;
  const font = cssFont(shape);
  const runs = takesTextStyle(shape.type) ? shape.textRuns : undefined;
  const segments = segmentsOf(text, runs);
  const align = takesTextStyle(shape.type) ? (shape.align ?? defaultAlign(shape.type)) : "left";
  const result = (
    size: number,
    scale: number,
    maxWidth: number,
    x: number,
    y: (height: number) => number,
  ): TextLayout => {
    const { rows, height } = setLines(
      text,
      segments,
      defaultsOf(shape, size),
      scale,
      maxWidth,
      align,
      measure,
      baselineOf,
    );
    return {
      fontSize: size * scale,
      scale,
      lines: rows.map((row) => row.text),
      widths: rows.map((row) => row.width),
      rows,
      height,
      align,
      font,
      x,
      y: y(height),
      width: maxWidth,
    };
  };
  if (shape.type === "frame") {
    // A frame's name sits above it, growing upward if it wraps.
    return result(FRAME_LABEL_SIZE, 1, w, -w / 2, (height) => -h / 2 - FRAME_LABEL_GAP - height);
  }
  if (shape.type === "text")
    return result(setSize(shape) ?? TEXT_FONT_SIZE, 1, w, -w / 2, () => -h / 2);

  // An ellipse's text goes in the largest rectangle of the same proportions inside it.
  const inset = shape.type === "ellipse" ? Math.SQRT1_2 : 1;
  const padding = Math.min(w, h) * 0.08;
  const boxW = Math.max(1, w * inset - 2 * padding);
  const boxH = Math.max(1, h * inset - 2 * padding);
  // A size that's been set is the largest the text gets: it still shrinks to fit.
  const largest = setSize(shape) ?? Math.min(64, Math.max(12, Math.min(w, h) * 0.12));
  const defaults = defaultsOf(shape, largest);
  const fits = (scale: number) =>
    setLines(text, segments, defaults, scale, boxW, align, measure, baselineOf).height <= boxH;
  let scale = 1;
  if (!fits(1)) {
    const biggest = Math.max(...segments.map((s) => s.marks.size ?? largest));
    let lo = Math.min(1, MIN_FIT_SIZE / biggest);
    let hi = 1;
    for (let i = 0; i < FIT_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    scale = lo;
  }
  return result(largest, scale, boxW, -boxW / 2, (height) =>
    shape.valign === "top"
      ? -boxH / 2
      : shape.valign === "bottom"
        ? boxH / 2 - height
        : -height / 2,
  );
}

/** A paragraph of a shape's text in pieces of one style each, as the editor shows it. */
export interface StyledParagraph {
  /** Where it starts in the shape's text. */
  readonly start: number;
  readonly align: TextAlign;
  /** In order; none when the paragraph is empty. */
  readonly pieces: ReadonlyArray<{ readonly text: string; readonly style: PieceStyle }>;
  /** What an empty paragraph is in: the size of its line, and of what's typed there. */
  readonly style: PieceStyle;
}

/** `shape`'s text as `layout` sets it, in paragraphs rather than lines. */
export function styledParagraphs(shape: Shape, layout: TextLayout): StyledParagraph[] {
  const { text } = shape;
  const segments = segmentsOf(text, takesTextStyle(shape.type) ? shape.textRuns : undefined);
  const defaults = defaultsOf(shape, layout.fontSize / layout.scale);
  const styleAt = (i: number): PieceStyle => {
    const segment =
      segments.find((s) => s.start <= i && i < s.end) ?? segments[segments.length - 1];
    return styleOf(defaults, segment?.marks ?? {}, layout.scale);
  };
  const paragraphs: StyledParagraph[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const pieces: Array<{ text: string; style: PieceStyle }> = [];
    for (const segment of segments) {
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      if (to > from)
        pieces.push({
          text: text.slice(from, to),
          style: styleOf(defaults, segment.marks, layout.scale),
        });
    }
    const own =
      newline === -1 ? undefined : segments.find((s) => s.start <= newline && newline < s.end);
    paragraphs.push({
      start,
      align: own?.marks.align ?? layout.align,
      pieces,
      style: styleAt(start < text.length ? start : Math.max(0, start - 1)),
    });
    if (newline === -1) return paragraphs;
    start = newline + 1;
  }
}

/** The height a text shape needs for its text, in its fonts and sizes: one line at least. */
export function fittedTextHeight(
  shape: Shape,
  measure: MeasureText,
  baselineOf?: BaselineOf,
): number {
  return layoutText(shape, measure, baselineOf).height;
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

/**
 * Color of a shape's text: `color` when some characters have one, or the
 * shape's text color, or else dark or white on solid fills, whichever
 * stands out more.
 */
export function inkColor(shape: Shape, palette: Palette, color: ColorName | null = null): string {
  // A color that's been set: on a note's paper, light in both themes, as on a light board.
  const set =
    color ?? (hasTextColor(shape.type) && shape.textColor !== "auto" ? shape.textColor : undefined);
  if (set) return (shape.type === "sticky" ? palette.ink : palette.solid)[set];
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

/** The marks of character `index` of a shape's text, its alignment aside. */
export function inlineMarksAt(shape: Shape, index: number): TextMarks {
  const { align: _, ...marks } = marksAt(shape.text, shape.textRuns, index);
  return marks;
}

export interface FontMetrics {
  readonly measure: MeasureText;
  /**
   * Distance from the top of a line to its baseline in `font` (a CSS font
   * at `MEASURE_SIZE`; plain text when absent), as a multiple of the font
   * size: where a browser puts it in a line box `LINE_HEIGHT` tall, so
   * canvas text sits exactly where the editor's text did.
   */
  baseline(font?: string): number;
  /** Forgets every measurement: a font finished loading, so widths changed. */
  clear(): void;
}

/** Measures with a canvas at a 100px reference size, remembering each string per font. */
export function canvasFontMetrics(): FontMetrics {
  const REFERENCE = MEASURE_SIZE;
  const ctx = document.createElement("canvas").getContext("2d");
  const widths = new Map<string, number>();
  const baselines = new Map<string, number>();
  let current = "";
  const use = (font: string) => {
    if (ctx && current !== font) {
      ctx.font = font;
      current = font;
    }
  };
  return {
    measure(text, font = DEFAULT_FONT) {
      const key = font === DEFAULT_FONT ? text : `${font}\n${text}`;
      let width = widths.get(key);
      if (width === undefined) {
        use(font);
        // Without a 2D context, guess: about half an em per character.
        width = ctx ? ctx.measureText(text).width / REFERENCE : text.length * 0.5;
        if (widths.size >= 20_000) widths.clear();
        widths.set(key, width);
      }
      return width;
    },
    baseline(font = DEFAULT_FONT) {
      let baseline = baselines.get(font);
      if (baseline === undefined) {
        let ascent = 0.9;
        let descent = 0.22;
        if (ctx) {
          use(font);
          const m = ctx.measureText("Hg");
          // The font's own ascent and descent, which CSS uses for a line's content area.
          if (m.fontBoundingBoxAscent > 0) {
            ascent = m.fontBoundingBoxAscent / REFERENCE;
            descent = m.fontBoundingBoxDescent / REFERENCE;
          }
        }
        // CSS centers the content area (ascent + descent) in the line box.
        baseline = (LINE_HEIGHT - ascent - descent) / 2 + ascent;
        baselines.set(font, baseline);
      }
      return baseline;
    },
    clear() {
      widths.clear();
      baselines.clear();
      // A canvas keeps the font it resolved: set it again on next use.
      current = "";
    },
  };
}

/**
 * Remembers each shape's layout, so a frame that changed nothing measures
 * nothing. One entry per shape: a board's worth always fits (a cache
 * smaller than the board would be emptied and refilled on every frame).
 */
export class TextLayouts {
  private readonly cache = new Map<ShapeId, { key: string; layout: TextLayout }>();

  constructor(
    private readonly measure: MeasureText,
    private readonly baselineOf?: BaselineOf,
  ) {}

  get(shape: Shape): TextLayout {
    const key = `${shape.type}|${shape.w}|${shape.h}|${cssFont(shape)}|${shape.underline}|${shape.strike}|${shape.fontSize}|${shape.align}|${shape.valign}|${shape.text}|${shape.textRuns ? JSON.stringify(shape.textRuns) : ""}`;
    const cached = this.cache.get(shape.id);
    if (cached?.key === key) return cached.layout;
    const layout = layoutText(shape, this.measure, this.baselineOf);
    // Deleted shapes are never evicted one by one: forget everything now and then.
    if (!cached && this.cache.size >= 100_000) this.cache.clear();
    this.cache.set(shape.id, { key, layout });
    return layout;
  }

  fittedHeight(shape: Shape): number {
    return fittedTextHeight(shape, this.measure, this.baselineOf);
  }

  /** Forgets every layout (a font finished loading). */
  clear(): void {
    this.cache.clear();
  }
}
