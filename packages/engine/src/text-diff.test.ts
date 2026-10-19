import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEdit, diffText, mapPosition, rebaseEdit, type TextEdit } from "./text-diff";

const apply = (text: string, edit: TextEdit | null) => (edit ? applyEdit(text, edit) : text);

describe("diffText", () => {
  it("finds a keystroke, a deletion and a paste over a selection", () => {
    expect(diffText("helo", "hello", 4)).toEqual({ index: 3, deleteCount: 0, insert: "l" });
    expect(diffText("hello", "helo", 3)).toEqual({ index: 3, deleteCount: 1, insert: "" });
    expect(diffText("hello world", "hello there", 11)).toEqual({
      index: 6,
      deleteCount: 5,
      insert: "there",
    });
    expect(diffText("same", "same")).toBeNull();
  });

  it("puts an ambiguous edit where the cursor is", () => {
    // An "a" typed into "aa" could have gone in at any of three places.
    expect(diffText("aa", "aaa", 1)).toEqual({ index: 0, deleteCount: 0, insert: "a" });
    expect(diffText("aa", "aaa", 2)).toEqual({ index: 1, deleteCount: 0, insert: "a" });
    expect(diffText("aa", "aaa", 3)).toEqual({ index: 2, deleteCount: 0, insert: "a" });
  });

  it("never splits a surrogate pair", () => {
    // 😀 and 😁 share their first code unit.
    expect(diffText("😀", "😁", 2)).toEqual({ index: 0, deleteCount: 2, insert: "😁" });
    // 😀 and 🈀 share their second.
    expect(diffText("x😀", "x🈀")).toEqual({ index: 1, deleteCount: 2, insert: "🈀" });
  });

  it("turns any text into any other, in whole characters", () => {
    const text = fc.string({ unit: fc.constantFrom("a", "b", "😀", "😁", "🈀"), maxLength: 12 });
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    fc.assert(
      fc.property(text, text, fc.option(fc.nat()), (before, after, caretSeed) => {
        const caret = caretSeed === null ? undefined : caretSeed % (after.length + 1);
        const edit = diffText(before, after, caret);
        expect(apply(before, edit)).toBe(after);
        if (!edit) return;
        // Whole characters only, inserted and deleted.
        expect(edit.insert).not.toMatch(loneSurrogate);
        expect(before.slice(edit.index, edit.index + edit.deleteCount)).not.toMatch(loneSurrogate);
      }),
    );
  });
});

describe("mapPosition", () => {
  const edit: TextEdit = { index: 2, deleteCount: 3, insert: "xy" };

  it("keeps positions before an edit, shifts those after, and moves those inside to its end", () => {
    expect(mapPosition(0, edit)).toBe(0);
    expect(mapPosition(2, edit)).toBe(2);
    expect(mapPosition(3, edit)).toBe(4);
    expect(mapPosition(5, edit)).toBe(4);
    expect(mapPosition(8, edit)).toBe(7);
  });
});

describe("rebaseEdit", () => {
  it("lands an edit where it was meant to after someone else's", () => {
    const base = "hello world";
    // Someone typed at the start while this user fixed "world".
    const remote = diffText(base, ">> hello world", 3);
    const local = diffText(base, "hello World", 7);
    if (!remote || !local) throw new Error("no edit");
    expect(apply(apply(base, remote), rebaseEdit(local, remote))).toBe(">> hello World");
  });

  it("keeps both people's text when they type at the same place", () => {
    const base = "ab";
    const remote = { index: 1, deleteCount: 0, insert: "X" };
    const local = { index: 1, deleteCount: 0, insert: "Y" };
    const merged = apply(apply(base, remote), rebaseEdit(local, remote));
    expect(merged).toContain("X");
    expect(merged).toContain("Y");
  });
});
