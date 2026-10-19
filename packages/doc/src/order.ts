import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Z-order with fractional indexes.
 *
 * Each shape stores a string key; shapes are drawn in key order, lowest first.
 * Moving a shape rewrites only its own key, to one that sorts between its new
 * neighbors, so two people reordering different shapes never conflict. Two
 * peers can still pick the same key at once (both add a shape on top), so
 * ties are broken by shape id, which every peer sees the same way.
 *
 * Keys compare with plain `<`, not `localeCompare`: the library's alphabet is
 * ordered by character code.
 */

interface Ordered {
  readonly id: string;
  readonly index: string;
}

export function compareOrder(a: Ordered, b: Ordered): number {
  if (a.index !== b.index) return a.index < b.index ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** The library's base-62 digits. It checks only a key's head, length and tail. */
const BASE62_KEY = /^[0-9A-Za-z]+$/;

export function isValidIndex(key: string): boolean {
  // A key with other characters passes the library's check, then makes it
  // generate keys outside the bounds it was given ("a0~" and "a1" give "a0V").
  if (key.length === 0 || key.length > 256 || !BASE62_KEY.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** A key above every shape in `ordered` (sorted with `compareOrder`). */
export function indexAbove(ordered: readonly Ordered[]): string {
  return generateKeyBetween(ordered.at(-1)?.index ?? null, null);
}

/** `n` increasing keys above every shape. */
export function indexesAbove(ordered: readonly Ordered[], n: number): string[] {
  return generateNKeysBetween(ordered.at(-1)?.index ?? null, null, n);
}

/**
 * `n` increasing keys between `below` and `above` (either may be null, for
 * no bound). Tied or crossed bounds, from concurrent edits, drop the upper
 * one: the keys still sort above `below`.
 */
export function indexesBetween(below: string | null, above: string | null, n: number): string[] {
  const upper = below !== null && above !== null && above <= below ? null : above;
  return generateNKeysBetween(below, upper, n);
}

/** `n` increasing keys below every shape. */
export function indexesBelow(ordered: readonly Ordered[], n: number): string[] {
  return generateNKeysBetween(null, ordered[0]?.index ?? null, n);
}

/**
 * New keys for the selected shapes after moving each one step up (`+1`) or
 * down (`-1`) past its nearest unselected neighbor. Selected shapes keep their
 * order relative to each other.
 *
 * Returns only the keys that change. `ordered` must be sorted with
 * `compareOrder`.
 */
export function reorderStep(
  ordered: readonly Ordered[],
  selected: ReadonlySet<string>,
  direction: 1 | -1,
): Map<string, string> {
  const list = [...ordered];
  const moved = new Set<string>();
  // Walk against the direction of travel so a selected run moves as a block.
  const start = direction === 1 ? list.length - 2 : 1;
  for (let i = start; i >= 0 && i < list.length; i -= direction) {
    const item = list[i];
    const next = list[i + direction];
    if (!item || !next || !selected.has(item.id) || selected.has(next.id)) continue;
    list[i] = next;
    list[i + direction] = item;
    moved.add(item.id);
  }
  return rekey(list, moved);
}

/** Keys that put the selected shapes on top (`+1`) or at the bottom (`-1`). */
export function reorderToEnd(
  ordered: readonly Ordered[],
  selected: ReadonlySet<string>,
  direction: 1 | -1,
): Map<string, string> {
  const picked = ordered.filter((s) => selected.has(s.id));
  const rest = ordered.filter((s) => !selected.has(s.id));
  const keys =
    direction === 1 ? indexesAbove(rest, picked.length) : indexesBelow(rest, picked.length);
  return new Map(picked.map((s, i) => [s.id, keys[i] as string]));
}

/**
 * Gives each id in `moved` a key between its neighbors in `list`, working up
 * from the bottom so each new key can build on the one below it. When the
 * neighbors share a key (a tie from concurrent edits), the upper bound skips
 * past the tied run.
 */
function rekey(list: readonly Ordered[], moved: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  const keyAt = (i: number) => {
    const item = list[i];
    return item ? (result.get(item.id) ?? item.index) : null;
  };
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || !moved.has(item.id)) continue;
    const below = i > 0 ? keyAt(i - 1) : null;
    let j = i + 1;
    let above = keyAt(j);
    while (above !== null && (moved.has(list[j]?.id ?? "") || (below !== null && above <= below))) {
      j++;
      above = keyAt(j);
    }
    result.set(item.id, generateKeyBetween(below, above));
  }
  return result;
}
