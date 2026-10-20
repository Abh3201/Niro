import {
  defaultAlign,
  type FontName,
  type FontSize,
  hasTextColor,
  type MarkPatch,
  marksAt,
  marksForInsert,
  patchMarks,
  type Shape,
  type TextAlign,
  type TextColor,
  type TextMarks,
  type TextRun,
  type VerticalAlign,
} from "@niro/doc";

/**
 * Formatting on parts of a shape's text, as the selection panel and the
 * shortcuts see it (docs/decisions/0014-rich-text.md). A shape's own
 * settings are what its unformatted text looks like; marks on a range of
 * characters override them there.
 */

/** Text formatting, as `Engine.setTextStyle` takes it. */
export interface TextStylePatch {
  readonly font?: FontName;
  readonly fontSize?: FontSize;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly align?: TextAlign;
  /** Boxes only. */
  readonly valign?: VerticalAlign;
  /** For boxes, their text color; for text shapes, their color (unless "auto"). */
  readonly textColor?: TextColor;
}

/** The text formatting a selection shares, per property; null where it differs. */
export interface TextStyle {
  readonly font: FontName | null;
  readonly fontSize: FontSize | null;
  readonly bold: boolean | null;
  readonly italic: boolean | null;
  readonly underline: boolean | null;
  readonly strike: boolean | null;
  readonly align: TextAlign | null;
  /** Null too when nothing selected is a box. */
  readonly valign: VerticalAlign | null;
  readonly textColor: TextColor | null;
  /** Something is a box (not a text shape), so vertical alignment applies. */
  readonly boxes: boolean;
}

/** The inline settings: the ones a mark can override. */
type InlineKey = "font" | "fontSize" | "bold" | "italic" | "underline" | "strike" | "textColor";
const INLINE_KEYS: readonly InlineKey[] = [
  "font",
  "fontSize",
  "bold",
  "italic",
  "underline",
  "strike",
  "textColor",
];

/** How characters with `marks` look in `shape`, for the inline settings. */
function inlineStyle(shape: Shape, marks: TextMarks): Pick<TextStyle, InlineKey> {
  return {
    font: marks.font ?? shape.font ?? "sans",
    fontSize: marks.size ?? shape.fontSize ?? "auto",
    bold: marks.bold ?? shape.bold === true,
    italic: marks.italic ?? shape.italic === true,
    underline: marks.underline ?? shape.underline === true,
    strike: marks.strike ?? shape.strike === true,
    textColor:
      marks.color ?? (hasTextColor(shape.type) ? (shape.textColor ?? "auto") : shape.color),
  };
}

/** A paragraph: `[start, end)` of the text, without the line break that ends it. */
export interface Paragraph {
  readonly start: number;
  readonly end: number;
}

/** The paragraphs `[start, end]` touches (at least the one `start` is in). */
export function paragraphsIn(text: string, start: number, end: number): Paragraph[] {
  let from = text.lastIndexOf("\n", start - 1) + 1;
  const result: Paragraph[] = [];
  for (;;) {
    const newline = text.indexOf("\n", from);
    const to = newline === -1 ? text.length : newline;
    result.push({ start: from, end: to });
    if (newline === -1 || newline >= end) return result;
    from = newline + 1;
  }
}

/** How a paragraph is aligned: as the line break ending it says, or else as the shape. */
export function paragraphAlign(shape: Shape, paragraph: Paragraph): TextAlign {
  const own =
    paragraph.end < shape.text.length
      ? marksAt(shape.text, shape.textRuns, paragraph.end).align
      : undefined;
  return own ?? shape.align ?? defaultAlign(shape.type);
}

/** Every mark run of `runs` overlapping `[start, end)`, as `[from, to, marks]`. */
function* runsIn(
  runs: readonly TextRun[] | undefined,
  length: number,
  start: number,
  end: number,
): Generator<[number, number, TextMarks]> {
  if (!runs) {
    if (end > start) yield [start, end, {}];
    return;
  }
  let at = 0;
  for (const run of runs) {
    const from = Math.max(start, at);
    const to = Math.min(end, at + run.length);
    if (to > from) yield [from, to, run.marks];
    at += run.length;
    if (at >= end) return;
  }
  if (at < Math.min(end, length)) yield [Math.max(start, at), Math.min(end, length), {}];
}

/**
 * The formatting of characters `[start, end)` of `shape`'s text, each
 * property null where they differ. A collapsed range is the caret: what
 * typing there would look like, `pending` (marks chosen for the next
 * character typed) included. Line breaks count only when nothing else is
 * in the range: they're not drawn.
 */
export function rangeTextStyle(
  shape: Shape,
  start: number,
  end: number,
  pending: MarkPatch | null = null,
): TextStyle {
  const { text } = shape;
  const styles: Array<Pick<TextStyle, InlineKey>> = [];
  if (start >= end) {
    const marks = marksForInsert(text, shape.textRuns, start);
    styles.push(inlineStyle(shape, pending ? patchMarks(marks, pending) : marks));
  } else {
    const all: Array<[number, number, TextMarks]> = [
      ...runsIn(shape.textRuns, text.length, start, end),
    ];
    // Runs made of line breaks only are left out, unless they're all there is.
    const drawn = all.filter(([from, to]) => /[^\n]/.test(text.slice(from, to)));
    for (const [, , marks] of drawn.length > 0 ? drawn : all)
      styles.push(inlineStyle(shape, marks));
  }
  const aligns = paragraphsIn(text, start, end).map((p) => paragraphAlign(shape, p));
  const box = hasTextColor(shape.type);
  return {
    ...(Object.fromEntries(
      INLINE_KEYS.map((key) => [key, common(styles.map((style) => style[key]))]),
    ) as Pick<TextStyle, InlineKey>),
    align: common(aligns),
    valign: box ? (shape.valign ?? "middle") : null,
    boxes: box,
  };
}

/** The formatting all of `shape`'s text shares. */
export const shapeTextStyle = (shape: Shape): TextStyle =>
  rangeTextStyle(shape, 0, shape.text.length);

/** What several shapes' formatting has in common. */
export function mergeTextStyles(styles: readonly TextStyle[]): TextStyle | null {
  if (styles.length === 0) return null;
  const pick = <K extends keyof TextStyle>(key: K) => common(styles.map((style) => style[key]));
  const boxes = styles.filter((style) => style.boxes);
  return {
    font: pick("font"),
    fontSize: pick("fontSize"),
    bold: pick("bold"),
    italic: pick("italic"),
    underline: pick("underline"),
    strike: pick("strike"),
    align: pick("align"),
    valign: common(boxes.map((style) => style.valign)),
    textColor: pick("textColor"),
    boxes: boxes.length > 0,
  };
}

function common<T>(values: readonly (T | null)[]): T | null {
  if (values.length === 0) return null;
  const first = values[0] as T | null;
  return values.every((value) => value === first) ? first : null;
}

/** The marks that set what `style` changes, on part of a shape's text (alignment and vertical alignment aside). */
export function inlinePatch(style: TextStylePatch): MarkPatch {
  const patch: Record<string, unknown> = {};
  if (style.font !== undefined) patch.font = style.font;
  if (style.fontSize !== undefined) patch.size = style.fontSize === "auto" ? null : style.fontSize;
  for (const key of ["bold", "italic", "underline", "strike"] as const)
    if (style[key] !== undefined) patch[key] = style[key];
  if (style.textColor !== undefined)
    patch.color = style.textColor === "auto" ? null : style.textColor;
  return patch as MarkPatch;
}

/**
 * The marks to take away when `style` is set on a whole shape: none of its
 * text keeps its own value for what was just set for all of it.
 */
export function clearedBy(style: TextStylePatch): MarkPatch {
  const patch: Record<string, null> = {};
  for (const name of Object.keys(inlinePatch(style))) patch[name] = null;
  if (style.align !== undefined) patch.align = null;
  return patch as MarkPatch;
}

/** Whether `patch` changes any mark. */
export const isEmptyPatch = (patch: MarkPatch) => Object.keys(patch).length === 0;
