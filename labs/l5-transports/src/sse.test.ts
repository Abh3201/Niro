import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FrameReader, frame } from "./frames";
import { formatEvent, SseParser } from "./sse";

describe("SseParser", () => {
  it("reads events, ids, comments and multi-line data", () => {
    const parser = new SseParser();
    const text = ": keep-alive\n\nid: 1\ndata: one\n\nevent: note\ndata:two\ndata: lines\r\n\r\n";
    expect(parser.push(text)).toEqual([
      { event: "message", data: "one", id: "1" },
      { event: "note", data: "two\nlines", id: "1" },
    ]);
  });

  it("reads the same events however the text is cut", () => {
    const data = fc.string({ unit: "grapheme" });
    fc.assert(
      fc.property(
        fc.array(data, { minLength: 1, maxLength: 5 }),
        fc.array(fc.nat()),
        (items, cuts) => {
          const text = items.map((d, i) => formatEvent(d, i)).join("");
          const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
          const parser = new SseParser();
          const events = [];
          let from = 0;
          for (const to of [...points, text.length]) {
            events.push(...parser.push(text.slice(from, to)));
            from = to;
          }
          // An event with no data lines isn't one; formatEvent always writes at least one.
          const expected = items.map((d, i) => ({
            event: "message",
            data: d.replace(/\r\n|\r/g, "\n"),
            id: String(i),
          }));
          expect(events).toEqual(expected);
        },
      ),
    );
  });
});

describe("FrameReader", () => {
  it("cuts a byte stream back into the messages written, however it arrives", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ maxLength: 50 })),
        fc.array(fc.nat()),
        (messages, cuts) => {
          const stream = Uint8Array.from(messages.flatMap((m) => [...frame(m)]));
          const points = [...new Set(cuts.map((c) => c % (stream.length + 1)))].sort(
            (a, b) => a - b,
          );
          const reader = new FrameReader();
          const out: Uint8Array[] = [];
          let from = 0;
          for (const to of [...points, stream.length]) {
            out.push(...reader.push(stream.subarray(from, to)));
            from = to;
          }
          expect(out).toEqual(messages);
        },
      ),
    );
  });

  it("refuses a length over the limit before waiting for the bytes", () => {
    expect(() => new FrameReader(10).push(frame(new Uint8Array(11)))).toThrow(/over the limit/);
  });
});
