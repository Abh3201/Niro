/**
 * The WebSocket framing layer (RFC 6455, section 5).
 *
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  +-+-+-+-+-------+-+-------------+-------------------------------+
 *  |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
 *  |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
 *  |N|V|V|V|       |S|             |   (if payload len==126/127)   |
 *  | |1|2|3|       |K|             |                               |
 *  +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
 *  |     Extended payload length continued, if payload len == 127  |
 *  + - - - - - - - - - - - - - - - +-------------------------------+
 *  |                               |Masking-key, if MASK set to 1  |
 *  +-------------------------------+-------------------------------+
 *  | Masking-key (continued)       |          Payload Data         |
 *  +-------------------------------- - - - - - - - - - - - - - - - +
 */

export const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;
export type Opcode = (typeof Opcode)[keyof typeof Opcode];

const OPCODES = new Set<number>(Object.values(Opcode));

/** Close codes this lab sends (RFC 6455, section 7.4.1). */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  /** Never sent on the wire: reported when the connection dropped without a close frame. */
  Abnormal: 1006,
  InvalidData: 1007,
  TooBig: 1009,
} as const;

/** A violation the peer made. The connection must close with `code`. */
export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Frame {
  readonly fin: boolean;
  readonly opcode: Opcode;
  /** Already unmasked. */
  readonly payload: Uint8Array;
}

export const isControl = (opcode: number) => (opcode & 0x8) !== 0;

/** Bytes received but not yet parsed. Avoids copying the whole buffer on every chunk. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
  }

  /** The byte at `index` from the front, without consuming it. */
  at(index: number): number {
    let i = index + this.offset;
    for (const chunk of this.chunks) {
      if (i < chunk.byteLength) return chunk[i] as number;
      i -= chunk.byteLength;
    }
    throw new RangeError("not enough bytes");
  }

  /** Removes `n` bytes from the front and returns them in one array. */
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0] as Uint8Array;
      const count = Math.min(n - filled, chunk.byteLength - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + count), filled);
      filled += count;
      this.offset += count;
      if (this.offset === chunk.byteLength) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.length -= n;
    return out;
  }
}

export interface FrameParserOptions {
  /** Largest payload accepted in one frame. Checked from the header, before buffering. */
  maxPayload: number;
  /** Frames from a client must be masked; frames from a server must not. */
  expectMasked: boolean;
}

/**
 * Turns a byte stream into frames. TCP delivers bytes, not messages: one
 * chunk can hold half a header, or three frames and the start of a fourth,
 * so the parser keeps whatever it can't use yet.
 */
export class FrameParser {
  private readonly queue = new ByteQueue();

  constructor(private readonly options: FrameParserOptions) {}

  /** Feeds bytes in. Read the frames they complete with `next`. */
  write(chunk: Uint8Array): void {
    this.queue.push(chunk);
  }

  /** Feeds bytes in and returns every frame now complete. */
  push(chunk: Uint8Array): Frame[] {
    this.write(chunk);
    const frames: Frame[] = [];
    for (let frame = this.next(); frame; frame = this.next()) frames.push(frame);
    return frames;
  }

  /** The next complete frame, or null until more bytes arrive. Throws `ProtocolError`. */
  next(): Frame | null {
    const q = this.queue;
    if (q.length < 2) return null;
    const b0 = q.at(0);
    const b1 = q.at(1);
    const fin = (b0 & 0x80) !== 0;
    // No extensions are negotiated, so the reserved bits must be zero.
    if ((b0 & 0x70) !== 0) throw new ProtocolError(CloseCode.ProtocolError, "reserved bits set");
    const opcode = b0 & 0x0f;
    if (!OPCODES.has(opcode))
      throw new ProtocolError(CloseCode.ProtocolError, `unknown opcode ${opcode}`);
    const masked = (b1 & 0x80) !== 0;
    if (masked !== this.options.expectMasked) {
      throw new ProtocolError(
        CloseCode.ProtocolError,
        masked ? "frame is masked" : "frame is not masked",
      );
    }

    const len7 = b1 & 0x7f;
    if (isControl(opcode)) {
      if (!fin) throw new ProtocolError(CloseCode.ProtocolError, "fragmented control frame");
      if (len7 > 125)
        throw new ProtocolError(CloseCode.ProtocolError, "control frame over 125 bytes");
    }
    const lengthBytes = len7 === 126 ? 2 : len7 === 127 ? 8 : 0;
    const headerLength = 2 + lengthBytes + (masked ? 4 : 0);
    if (q.length < headerLength) return null;

    let length = len7;
    if (len7 === 126) {
      length = (q.at(2) << 8) | q.at(3);
    } else if (len7 === 127) {
      if (q.at(2) & 0x80)
        throw new ProtocolError(CloseCode.ProtocolError, "64-bit length has its top bit set");
      let high = 0;
      for (let i = 2; i < 6; i++) high = high * 256 + q.at(i);
      let low = 0;
      for (let i = 6; i < 10; i++) low = low * 256 + q.at(i);
      length = high * 2 ** 32 + low;
    }
    // Refuse before buffering: a header can claim 2^63 bytes for free.
    if (length > this.options.maxPayload) {
      throw new ProtocolError(CloseCode.TooBig, `frame of ${length} bytes is over the limit`);
    }
    if (q.length < headerLength + length) return null;

    const header = q.take(headerLength);
    const payload = q.take(length);
    if (masked) unmask(payload, header.subarray(headerLength - 4));
    return { fin, opcode: opcode as Opcode, payload };
  }
}

/** XORs `data` with the 4-byte key, in place. Masking twice restores the input. */
export function unmask(data: Uint8Array, key: Uint8Array): void {
  for (let i = 0; i < data.byteLength; i++) data[i] = (data[i] as number) ^ (key[i & 3] as number);
}

export interface EncodeOptions {
  fin?: boolean;
  /** Clients must mask every frame with a fresh random key; servers never mask. */
  mask?: Uint8Array;
}

export function encodeFrame(
  opcode: Opcode,
  payload: Uint8Array,
  options: EncodeOptions = {},
): Uint8Array {
  const { fin = true, mask } = options;
  const length = payload.byteLength;
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const headerLength = 2 + lengthBytes + (mask ? 4 : 0);
  const out = new Uint8Array(headerLength + length);
  out[0] = (fin ? 0x80 : 0) | opcode;
  out[1] = (mask ? 0x80 : 0) | (lengthBytes === 0 ? length : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) {
    out[2] = length >>> 8;
    out[3] = length & 0xff;
  } else if (lengthBytes === 8) {
    const high = Math.floor(length / 2 ** 32);
    const view = new DataView(out.buffer);
    view.setUint32(2, high);
    view.setUint32(6, length >>> 0);
  }
  out.set(payload, headerLength);
  if (mask) {
    out.set(mask.subarray(0, 4), headerLength - 4);
    unmask(out.subarray(headerLength), mask);
  }
  return out;
}

/** A close frame's payload: a 2-byte code, then an optional UTF-8 reason. */
export function encodeClose(code: number, reason = ""): Uint8Array {
  const text = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + text.byteLength);
  out[0] = code >>> 8;
  out[1] = code & 0xff;
  out.set(text, 2);
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes UTF-8, closing with 1007 when it isn't valid. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ProtocolError(CloseCode.InvalidData, "text is not valid UTF-8");
  }
}

/** Parses a received close payload. An empty payload means "no code given" (1005). */
export function decodeClose(payload: Uint8Array): { code: number; reason: string } {
  if (payload.byteLength === 0) return { code: 1005, reason: "" };
  if (payload.byteLength === 1)
    throw new ProtocolError(CloseCode.ProtocolError, "close payload of 1 byte");
  const code = ((payload[0] as number) << 8) | (payload[1] as number);
  if (!isValidCloseCode(code))
    throw new ProtocolError(CloseCode.ProtocolError, `invalid close code ${code}`);
  return { code, reason: decodeText(payload.subarray(2)) };
}

/** Codes a peer may send: the registered ones, minus those reserved for local use, plus 3000-4999. */
export function isValidCloseCode(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}
