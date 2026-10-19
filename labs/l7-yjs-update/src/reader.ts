/**
 * Reads the primitives a Yjs update is made of (lib0's encoding), and
 * remembers which bytes each value came from, so a decode can be printed
 * next to the bytes it read.
 */

/** One value read: bytes `[start, end)`, what it means, and what it was. */
export interface Note {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly value: string;
}

export class Reader {
  pos = 0;
  readonly notes: Note[] = [];
  /** Labels of the values being read, outermost first, as "struct 2 / content". */
  private readonly context: string[] = [];

  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  /** Reads within `label`: notes made inside are labelled "label / ...". */
  within<T>(label: string, read: () => T): T {
    this.context.push(label);
    try {
      return read();
    } finally {
      this.context.pop();
    }
  }

  /** One byte. */
  uint8(label: string): number {
    const start = this.pos;
    const byte = this.next();
    this.note(start, label, byte);
    return byte;
  }

  /**
   * An unsigned integer in 7-bit groups, lowest first; the top bit of each
   * byte says another follows. 0–127 take one byte, up to 16,383 two.
   */
  varUint(label: string): number {
    const start = this.pos;
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.next();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 128;
      if (value > Number.MAX_SAFE_INTEGER) throw new Error(`${label}: integer too big at ${start}`);
    }
    this.note(start, label, value);
    return value;
  }

  /**
   * A signed integer: like `varUint`, but the first byte gives up a bit for
   * the sign (0x40) and keeps only 6 bits of the number.
   */
  varInt(label: string): number {
    const start = this.pos;
    const first = this.next();
    const negative = (first & 0x40) !== 0;
    let value = first & 0x3f;
    let scale = 64;
    let byte = first;
    while (byte >= 0x80) {
      byte = this.next();
      value += (byte & 0x7f) * scale;
      scale *= 128;
    }
    const result = negative ? -value : value;
    this.note(start, label, result);
    return result;
  }

  /** UTF-8 bytes, after their count as a `varUint`. */
  varString(label: string): string {
    const start = this.pos;
    const length = this.varUint("");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      this.take(length),
    );
    this.note(start, label, JSON.stringify(text));
    return text;
  }

  /** Bytes, after their count as a `varUint`. */
  varBytes(label: string): Uint8Array {
    const start = this.pos;
    const length = this.varUint("");
    const bytes = this.take(length).slice();
    this.note(start, label, `${length} bytes`);
    return bytes;
  }

  /**
   * lib0's self-describing value: a tag byte counting down from 127 for the
   * type, then the value. JSON-like, plus undefined, bigint and bytes.
   */
  any(label: string): unknown {
    const start = this.pos;
    const value = this.anyValue();
    this.note(start, label, show(value));
    return value;
  }

  private anyValue(): unknown {
    const tag = this.next();
    switch (tag) {
      case 127:
        return undefined;
      case 126:
        return null;
      case 125:
        return this.varInt("");
      case 124:
        return this.view(4).getFloat32(0);
      case 123:
        return this.view(8).getFloat64(0);
      case 122:
        return this.view(8).getBigInt64(0);
      case 121:
        return false;
      case 120:
        return true;
      case 119:
        return this.varString("");
      case 118: {
        const size = this.varUint("");
        const object: Record<string, unknown> = {};
        for (let i = 0; i < size; i++) {
          const key = this.varString("");
          object[key] = this.anyValue();
        }
        return object;
      }
      case 117: {
        const size = this.varUint("");
        const array: unknown[] = [];
        for (let i = 0; i < size; i++) array.push(this.anyValue());
        return array;
      }
      case 116:
        return this.varBytes("");
      default:
        throw new Error(`unknown value tag ${tag} at ${this.pos - 1}`);
    }
  }

  /** Big-endian, as lib0 writes numbers of a fixed size. */
  private view(size: number): DataView {
    const bytes = this.take(size);
    return new DataView(bytes.buffer, bytes.byteOffset, size);
  }

  private next(): number {
    const byte = this.bytes[this.pos];
    if (byte === undefined) throw new Error(`update ends early, at byte ${this.pos}`);
    this.pos++;
    return byte;
  }

  private take(length: number): Uint8Array {
    if (this.pos + length > this.bytes.length) {
      throw new Error(`update ends early: ${length} bytes wanted at ${this.pos}`);
    }
    const bytes = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  /** Records a value read; one read as part of another (`label` "") isn't recorded. */
  private note(start: number, label: string, value: unknown): void {
    if (label === "") return;
    const path = [...this.context, label].join(" / ");
    this.notes.push({ start, end: this.pos, label: path, value: String(value) });
  }
}

/** A value as text, for notes. */
export function show(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Uint8Array) return `${value.length} bytes`;
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
}
