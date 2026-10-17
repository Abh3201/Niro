import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CloseCode,
  decodeClose,
  encodeClose,
  encodeFrame,
  type Frame,
  FrameParser,
  Opcode,
  ProtocolError,
} from "./frame";
import { acceptKey, handshake } from "./handshake";

const clientParser = (maxPayload = 1 << 20) => new FrameParser({ maxPayload, expectMasked: true });
const MASK = Uint8Array.of(0x12, 0x34, 0x56, 0x78);

/** The close code a ProtocolError thrown by `fn` carries. */
function closeCodeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProtocolError) return error.code;
    throw error;
  }
  throw new Error("expected a ProtocolError");
}

const request = (headers: Record<string, string>) =>
  [
    "GET /chat HTTP/1.1",
    "Host: localhost",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ].join("\r\n");

const VALID = {
  Upgrade: "websocket",
  Connection: "keep-alive, Upgrade",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
};

describe("handshake", () => {
  it("computes the accept key from the RFC's own example", () => {
    // RFC 6455, section 1.3.
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("upgrades a valid request", () => {
    const result = handshake(request(VALID));
    expect(result.ok).toBe(true);
    expect(result.response).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
    );
    if (result.ok) expect(result.request.path).toBe("/chat");
  });

  it("rejects requests that aren't WebSocket upgrades", () => {
    const status = (headers: Record<string, string>, options = {}) =>
      handshake(request(headers), options).response.split("\r\n")[0];
    expect(status({ ...VALID, Upgrade: "h2c" })).toBe("HTTP/1.1 400 Bad Request");
    expect(status({ ...VALID, Connection: "keep-alive" })).toBe("HTTP/1.1 400 Bad Request");
    expect(status({ ...VALID, "Sec-WebSocket-Key": "short" })).toBe("HTTP/1.1 400 Bad Request");
    expect(status({ ...VALID, "Sec-WebSocket-Version": "8" })).toBe(
      "HTTP/1.1 426 Upgrade Required",
    );
    expect(handshake(request({ ...VALID, "Sec-WebSocket-Version": "8" })).response).toContain(
      "Sec-WebSocket-Version: 13",
    );
    expect(
      handshake(`POST / HTTP/1.1\r\n${request(VALID).split("\r\n").slice(1).join("\r\n")}`).ok,
    ).toBe(false);
    const allowOrigin = (origin: string | undefined) => origin === "https://niro.example";
    expect(status({ ...VALID, Origin: "https://evil.example" }, { allowOrigin })).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(status({ ...VALID, Origin: "https://niro.example" }, { allowOrigin })).toBe(
      "HTTP/1.1 101 Switching Protocols",
    );
  });
});

/** Payload lengths around each length-encoding boundary: 125/126 and 65535/65536. */
const payloadLength = fc.oneof(
  fc.integer({ min: 0, max: 130 }),
  fc.integer({ min: 65_530, max: 65_540 }),
  fc.constant(100_000),
);

const frameArb = fc
  .record({
    opcode: fc.constantFrom(
      Opcode.Text,
      Opcode.Binary,
      Opcode.Continuation,
      Opcode.Ping,
      Opcode.Pong,
    ),
    fin: fc.boolean(),
    length: payloadLength,
    fill: fc.nat(255),
    mask: fc.uint8Array({ minLength: 4, maxLength: 4 }),
  })
  .map(({ opcode, fin, length, fill, mask }) => {
    const control = opcode === Opcode.Ping || opcode === Opcode.Pong;
    const size = control ? length % 126 : length;
    const payload = Uint8Array.from({ length: size }, (_, i) => (i * 31 + fill) & 0xff);
    const frame: Frame = { opcode, fin: control || fin, payload };
    return { frame, mask };
  });

describe("frames", () => {
  it("round-trip however the byte stream is split", () => {
    fc.assert(
      fc.property(
        fc.array(frameArb, { minLength: 1, maxLength: 4 }),
        fc.array(fc.nat()),
        (frames, cuts) => {
          const encoded = frames.map(({ frame, mask }) =>
            encodeFrame(frame.opcode, frame.payload, { fin: frame.fin, mask }),
          );
          const stream = new Uint8Array(encoded.reduce((n, e) => n + e.byteLength, 0));
          let offset = 0;
          for (const e of encoded) {
            stream.set(e, offset);
            offset += e.byteLength;
          }
          const points = [...new Set(cuts.map((c) => c % (stream.byteLength + 1)))].sort(
            (a, b) => a - b,
          );
          const parser = clientParser();
          const out: Frame[] = [];
          let start = 0;
          for (const point of [...points, stream.byteLength]) {
            out.push(...parser.push(stream.subarray(start, point)));
            start = point;
          }
          // Payloads compared as base64: deep equality on 100 kB arrays is slow.
          const summary = (f: Frame) => ({
            ...f,
            payload: Buffer.from(f.payload).toString("base64"),
          });
          expect(out.map(summary)).toEqual(frames.map(({ frame }) => summary(frame)));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("uses the shortest length encoding", () => {
    const header = (length: number) =>
      encodeFrame(Opcode.Binary, new Uint8Array(length)).byteLength - length;
    expect([header(125), header(126), header(65_535), header(65_536)]).toEqual([2, 4, 4, 10]);
  });

  it("refuses frames a client must not send", () => {
    const frame = (bytes: number[]) => () => clientParser().push(Uint8Array.from(bytes));
    const masked = (b0: number, length: number) =>
      frame([b0, 0x80 | length, ...MASK, ...new Array(length).fill(0)]);
    expect(closeCodeOf(frame([0x81, 0x00]))).toBe(CloseCode.ProtocolError); // not masked
    expect(closeCodeOf(masked(0xc1, 0))).toBe(CloseCode.ProtocolError); // RSV1 without an extension
    expect(closeCodeOf(masked(0x83, 0))).toBe(CloseCode.ProtocolError); // reserved opcode 3
    expect(closeCodeOf(masked(0x09, 0))).toBe(CloseCode.ProtocolError); // fragmented ping
    expect(closeCodeOf(frame([0x89, 0x80 | 126, 0, 126]))).toBe(CloseCode.ProtocolError); // ping over 125
    // A 64-bit length with its top bit set.
    expect(closeCodeOf(frame([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 1, ...MASK]))).toBe(
      CloseCode.ProtocolError,
    );
  });

  it("refuses an oversized frame from its header alone", () => {
    // Claims 2^40 bytes; only the 14-byte header is ever sent.
    const header = Uint8Array.of(0x82, 0x80 | 127, 0, 0, 1, 0, 0, 0, 0, 0, ...MASK);
    expect(closeCodeOf(() => clientParser(1024).push(header))).toBe(CloseCode.TooBig);
  });

  it("parses close payloads", () => {
    expect(decodeClose(encodeClose(4000, "bye 👋"))).toEqual({ code: 4000, reason: "bye 👋" });
    expect(decodeClose(new Uint8Array(0))).toEqual({ code: 1005, reason: "" });
    expect(closeCodeOf(() => decodeClose(Uint8Array.of(3)))).toBe(CloseCode.ProtocolError);
    for (const code of [999, 1004, 1005, 1006, 1015, 2000, 5000]) {
      expect(closeCodeOf(() => decodeClose(encodeClose(code)))).toBe(CloseCode.ProtocolError);
    }
    const badReason = Uint8Array.of(0x03, 0xe8, 0xc3, 0x28);
    expect(closeCodeOf(() => decodeClose(badReason))).toBe(CloseCode.InvalidData);
  });
});
