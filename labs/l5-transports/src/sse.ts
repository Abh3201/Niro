/**
 * Server-sent events: a response that never ends, in lines of text.
 *
 *     id: 7
 *     data: {"text":"hi"}
 *
 * A blank line ends an event. `data:` lines join with newlines, `id:` is
 * what the browser sends back as `Last-Event-ID` when it reconnects, and a
 * line starting with `:` is a comment (handy as a keep-alive).
 */

export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

/** Writes one event; `data` may hold newlines. */
export function formatEvent(data: string, id?: number | string): string {
  const lines = data.split(/\r\n|\r|\n/).map((line) => `data: ${line}\n`);
  return `${id === undefined ? "" : `id: ${id}\n`}${lines.join("")}\n`;
}

/**
 * Reads events from text that arrives in pieces cut anywhere, even between
 * the \r and \n of one line ending.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;

  /** Takes the next piece of text; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const end = this.buffer.search(/\r\n|\r|\n/);
      if (end === -1) break;
      // A \r at the very end might be the first half of \r\n: wait for more.
      if (this.buffer[end] === "\r" && end === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + (this.buffer.startsWith("\r\n", end) ? 2 : 1));
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const event = { event: this.event || "message", data: this.data.join("\n"), id: this.id };
      this.data = [];
      this.event = "";
      return event;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}
