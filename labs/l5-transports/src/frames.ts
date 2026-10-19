/**
 * Messages on a byte stream. A WebTransport (or TCP) stream is bytes with no
 * edges: two writes can arrive as one read, or one as two. So each message
 * goes out after its length, 4 bytes, big-endian, and the reader cuts the
 * stream back into messages. WebSocket does this for you; that's half of
 * what its frames are for.
 */

export function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, 4);
  return out;
}

export class FrameReader {
  private buffer = new Uint8Array(0);

  constructor(private readonly maxSize = 1 << 20) {}

  /** Takes the next bytes read; returns the messages they completed. */
  push(bytes: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    const messages: Uint8Array[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const size = new DataView(joined.buffer, at, 4).getUint32(0);
      if (size > this.maxSize) throw new Error(`message of ${size} bytes is over the limit`);
      if (joined.length - at - 4 < size) break;
      messages.push(joined.slice(at + 4, at + 4 + size));
      at += 4 + size;
    }
    this.buffer = joined.slice(at);
    return messages;
  }
}
