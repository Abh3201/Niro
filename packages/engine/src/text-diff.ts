import type { TextEdit } from "@niro/doc";
import { isHighSurrogate, isLowSurrogate } from "./text";

export type { TextEdit };

export function applyEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.index) + edit.insert + text.slice(edit.index + edit.deleteCount);
}

/**
 * The one edit that turns `before` into `after`: what they start and end
 * with is kept, the middle replaced. A textarea reports its new value, not
 * what was typed, and this recovers the keystroke from it.
 *
 * Text like "aa" to "aaa" fits several edits; `caret`, the cursor position
 * after the change, picks the one that ends where the cursor is, so the
 * edit lands where the user typed (which matters when someone else is
 * typing in the same text). The edit never splits a surrogate pair.
 */
export function diffText(before: string, after: string, caret?: number): TextEdit | null {
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);
  // Matching ends first, but not past the caret: the change ends there.
  const endLimit = caret === undefined ? shorter : Math.min(shorter, after.length - caret);
  let end = 0;
  while (
    end < endLimit &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  )
    end++;
  let start = 0;
  while (start < shorter - end && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end--;
  return {
    index: start,
    deleteCount: before.length - start - end,
    insert: after.slice(start, after.length - end),
  };
}

/**
 * Where position `at` in the text before `edit` is after it. A position
 * inside the replaced characters moves to the end of their replacement; one
 * exactly where the edit starts stays put, before anything inserted there.
 */
export function mapPosition(at: number, edit: TextEdit): number {
  if (at <= edit.index) return at;
  if (at >= edit.index + edit.deleteCount) return at + edit.insert.length - edit.deleteCount;
  return edit.index + edit.insert.length;
}

/**
 * `local`, an edit made to some text, moved onto that text as changed by
 * `remote` in the meantime, so it applies where it was meant to.
 */
export function rebaseEdit(local: TextEdit, remote: TextEdit): TextEdit {
  const index = mapPosition(local.index, remote);
  const end = Math.max(index, mapPosition(local.index + local.deleteCount, remote));
  return { index, deleteCount: end - index, insert: local.insert };
}
