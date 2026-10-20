import {
  ALIGNS,
  COLORS,
  type ColorName,
  FONTS,
  type FontName,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type TextAlign,
} from "./shape";

/**
 * Formatting on part of a shape's text (docs/decisions/0014-rich-text.md).
 * Each key overrides the shape's own setting for those characters; absent
 * means the shape's. `false` is meaningful: one plain word in a bold note.
 */
export interface TextMarks {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly font?: FontName;
  /** World units, like `Shape.fontSize`; in a box, scaled down with the rest when text doesn't fit. */
  readonly size?: number;
  readonly color?: ColorName;
  /** On a line break only: how the paragraph it ends is aligned. The last paragraph uses `Shape.align`. */
  readonly align?: TextAlign;
}

export type MarkName = keyof TextMarks;
export const MARK_NAMES: readonly MarkName[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "font",
  "size",
  "color",
  "align",
];

/** A change to marks: a value sets it, null takes the override away. */
export type MarkPatch = { readonly [K in MarkName]?: TextMarks[K] | null };

/**
 * `length` characters of a shape's text with the same marks. A shape's runs
 * cover its whole text, in order; a shape with no formatting on any part
 * of its text has none.
 */
export interface TextRun {
  readonly length: number;
  readonly marks: TextMarks;
}

/** Most runs read per shape: past it, a hostile client could freeze every tab. */
const MAX_RUNS = 10_000;

/** One mark as stored, or undefined when it isn't a valid value for that mark. */
function readMark(name: MarkName, value: unknown): TextMarks[MarkName] | undefined {
  switch (name) {
    case "bold":
    case "italic":
    case "underline":
    case "strike":
      return typeof value === "boolean" ? value : undefined;
    case "font":
      return typeof value === "string" && (FONTS as readonly string[]).includes(value)
        ? (value as FontName)
        : undefined;
    case "size":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value))
        : undefined;
    case "color":
      return typeof value === "string" && (COLORS as readonly string[]).includes(value)
        ? (value as ColorName)
        : undefined;
    case "align":
      return typeof value === "string" && (ALIGNS as readonly string[]).includes(value)
        ? (value as TextAlign)
        : undefined;
  }
}

/** The valid marks among whatever is stored, as a fresh object. */
export function readMarks(raw: unknown): TextMarks {
  if (typeof raw !== "object" || raw === null) return {};
  const marks: Record<string, unknown> = {};
  for (const name of MARK_NAMES) {
    const value = readMark(name, (raw as Record<string, unknown>)[name]);
    if (value !== undefined) marks[name] = value;
  }
  return marks as TextMarks;
}

const sameMarks = (a: TextMarks, b: TextMarks): boolean =>
  MARK_NAMES.every((name) => a[name] === b[name]);

const isEmpty = (marks: TextMarks): boolean =>
  MARK_NAMES.every((name) => marks[name] === undefined);

/**
 * Runs as stored, for text `length` long: valid marks only, neighbours
 * with the same marks merged, and none at all when nothing is formatted.
 * Runs that don't add up to the text's length can't be placed, so they're
 * dropped (the text is drawn unformatted) rather than guessed at.
 */
export function readRuns(raw: unknown, length: number): readonly TextRun[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RUNS) return undefined;
  const runs: TextRun[] = [];
  let total = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const n = (item as Record<string, unknown>).length;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return undefined;
    total += n;
    push(runs, n, readMarks((item as Record<string, unknown>).marks));
  }
  if (total !== length || runs.every((run) => isEmpty(run.marks))) return undefined;
  return runs;
}

function push(runs: TextRun[], length: number, marks: TextMarks): void {
  if (length <= 0) return;
  const last = runs[runs.length - 1];
  if (last && sameMarks(last.marks, marks))
    runs[runs.length - 1] = { length: last.length + length, marks };
  else runs.push({ length, marks });
}

/** Marks per character: the simplest form to edit. */
function perCharacter(length: number, runs: readonly TextRun[] | undefined): TextMarks[] {
  const result: TextMarks[] = [];
  for (const run of runs ?? []) for (let i = 0; i < run.length; i++) result.push(run.marks);
  while (result.length < length) result.push({});
  return result.slice(0, length);
}

function toRuns(marks: readonly TextMarks[]): readonly TextRun[] | undefined {
  const runs: TextRun[] = [];
  for (const m of marks) push(runs, 1, m);
  return runs.length === 0 || runs.every((run) => isEmpty(run.marks)) ? undefined : runs;
}

/** `patch` applied to `marks`. */
export function patchMarks(marks: TextMarks, patch: MarkPatch): TextMarks {
  const result: Record<string, unknown> = { ...marks };
  for (const name of MARK_NAMES) {
    if (!(name in patch)) continue;
    const value = patch[name];
    if (value === null || value === undefined) delete result[name];
    else result[name] = value;
  }
  return result as TextMarks;
}

/** The marks of character `index` (for an insert there, see `marksForInsert`). */
export function marksAt(
  text: string,
  runs: readonly TextRun[] | undefined,
  index: number,
): TextMarks {
  if (!runs || index < 0 || index >= text.length) return {};
  let at = 0;
  for (const run of runs) {
    if (index < at + run.length) return run.marks;
    at += run.length;
  }
  return {};
}

/**
 * What a character typed at `index` is formatted with: like the one before
 * it, so a new line carries on in the heading's style. At the start of a
 * line, like the line's first character, as word processors do; on an empty
 * line, like the line break that holds its style (see `styleIndex`). Never
 * a paragraph's alignment: that belongs to line breaks.
 */
export function marksForInsert(
  text: string,
  runs: readonly TextRun[] | undefined,
  index: number,
): TextMarks {
  const lineStart = index === 0 || text[index - 1] === "\n";
  const { align: _, ...marks } = marksAt(
    text,
    runs,
    lineStart ? styleIndex(text, index) : index - 1,
  );
  return marks;
}

/**
 * The character whose marks a line starting at `index` is drawn in when it's
 * empty: the line break that ends it, or for the last line, the one before.
 */
export function styleIndex(text: string, index: number): number {
  return index < text.length ? index : Math.max(0, index - 1);
}

/**
 * Text and runs after replacing `deleteCount` characters at `index` with
 * `insert`, formatted with `marks` (as `Tx.editText` does).
 */
export function editRuns(
  text: string,
  runs: readonly TextRun[] | undefined,
  index: number,
  deleteCount: number,
  insert: string,
  marks: TextMarks = {},
): { text: string; runs: readonly TextRun[] | undefined } {
  const at = Math.max(0, Math.min(Math.trunc(index), text.length));
  const remove = Math.max(0, Math.min(Math.trunc(deleteCount), text.length - at));
  const chars = perCharacter(text.length, runs);
  chars.splice(at, remove, ...Array.from({ length: insert.length }, () => marks));
  return {
    text: text.slice(0, at) + insert + text.slice(at + remove),
    runs: toRuns(chars),
  };
}

/** Runs after `patch` is applied to `length` characters at `index` (as `Tx.formatText` does). */
export function formatRuns(
  text: string,
  runs: readonly TextRun[] | undefined,
  index: number,
  length: number,
  patch: MarkPatch,
): readonly TextRun[] | undefined {
  const at = Math.max(0, Math.min(Math.trunc(index), text.length));
  const end = Math.max(at, Math.min(at + Math.trunc(length), text.length));
  const chars = perCharacter(text.length, runs);
  for (let i = at; i < end; i++) chars[i] = patchMarks(chars[i] as TextMarks, patch);
  return toRuns(chars);
}
