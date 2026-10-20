import { describe, expect, it } from "vitest";
import { editRuns, formatRuns, marksForInsert, readRuns, styleIndex } from "./text-runs";

describe("readRuns", () => {
  it("keeps valid marks, merges neighbours alike, and drops runs that don't fit the text", () => {
    expect(
      readRuns(
        [
          { length: 2, marks: { bold: true, size: 9999, color: "red", junk: 1 } },
          { length: 1, marks: { bold: true, size: 400, color: "red" } },
          { length: 3, marks: { font: "comic" } },
        ],
        6,
      ),
    ).toEqual([
      { length: 3, marks: { bold: true, size: 400, color: "red" } },
      { length: 3, marks: {} },
    ]);
    // Runs that add up to the wrong length can't be placed.
    expect(readRuns([{ length: 2, marks: { bold: true } }], 3)).toBeUndefined();
    // Nothing formatted: no runs.
    expect(readRuns([{ length: 3, marks: { font: "comic" } }], 3)).toBeUndefined();
    expect(readRuns([{ length: 0, marks: { bold: true } }], 0)).toBeUndefined();
    expect(readRuns("bold", 4)).toBeUndefined();
  });
});

describe("editRuns and formatRuns", () => {
  it("format ranges and give inserted text the marks it's typed with", () => {
    const runs = formatRuns("Title\nbody", undefined, 0, 6, { underline: true });
    expect(runs).toEqual([
      { length: 6, marks: { underline: true } },
      { length: 4, marks: {} },
    ]);
    const typed = editRuns("Title\nbody", runs, 10, 0, "!", { bold: true });
    expect(typed).toEqual({
      text: "Title\nbody!",
      runs: [
        { length: 6, marks: { underline: true } },
        { length: 4, marks: {} },
        { length: 1, marks: { bold: true } },
      ],
    });
    // Taking every mark away leaves no runs.
    expect(
      formatRuns("ab", [{ length: 2, marks: { bold: true } }], 0, 2, { bold: null }),
    ).toBeUndefined();
    // Deleting formatted text deletes its marks.
    expect(
      editRuns(
        "ab",
        [
          { length: 1, marks: { bold: true } },
          { length: 1, marks: {} },
        ],
        0,
        1,
        "",
      ),
    ).toEqual({
      text: "b",
      runs: undefined,
    });
  });
});

describe("marksForInsert", () => {
  const text = "Title\n\nbody";
  const runs = [
    { length: 5, marks: { bold: true } },
    { length: 1, marks: { underline: true, align: "right" as const } },
    { length: 1, marks: { italic: true } },
    { length: 4, marks: { size: 10 } },
  ];

  it("takes the character before, but a line's first character at its start", () => {
    expect(marksForInsert(text, runs, 3)).toEqual({ bold: true });
    expect(marksForInsert(text, runs, 5)).toEqual({ bold: true });
    // At the start of "body": like "b".
    expect(marksForInsert(text, runs, 7)).toEqual({ size: 10 });
    expect(marksForInsert(text, runs, 0)).toEqual({ bold: true });
  });

  it("on an empty line, takes the line break that holds its style, alignment aside", () => {
    expect(marksForInsert(text, runs, 6)).toEqual({ italic: true });
    expect(styleIndex("ab\n", 3)).toBe(2);
    expect(
      marksForInsert("ab\n", [{ length: 3, marks: { strike: true, align: "left" } }], 3),
    ).toEqual({
      strike: true,
    });
    expect(marksForInsert("", undefined, 0)).toEqual({});
  });
});
