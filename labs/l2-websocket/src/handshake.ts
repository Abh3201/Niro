import { createHash } from "node:crypto";

/**
 * The opening handshake (RFC 6455, section 4). A WebSocket starts life as an
 * HTTP/1.1 GET with `Upgrade: websocket`. The server proves it speaks the
 * protocol by hashing the client's random key with a fixed GUID, then both
 * sides switch from HTTP to frames on the same TCP connection.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Longest request head accepted, in bytes. */
export const MAX_HEAD_BYTES = 8192;

/** `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key`: base64(sha1(key + GUID)). */
export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

export interface UpgradeRequest {
  readonly path: string;
  /** Header names lower-cased; repeated headers joined with ", ". */
  readonly headers: ReadonlyMap<string, string>;
}

export type HandshakeResult =
  | { readonly ok: true; readonly request: UpgradeRequest; readonly response: string }
  | { readonly ok: false; readonly response: string };

export interface HandshakeOptions {
  /**
   * Browsers send `Origin` but don't apply CORS to WebSockets: any page can
   * open a socket to your server with the user's cookies. Checking the
   * origin is the server's job.
   */
  allowOrigin?: (origin: string | undefined) => boolean;
}

const tokens = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

const reject = (status: string, extra = ""): HandshakeResult => ({
  ok: false,
  response: `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`,
});

/** Validates a request head (everything before the blank line) and builds the response. */
export function handshake(head: string, options: HandshakeOptions = {}): HandshakeResult {
  const [requestLine = "", ...lines] = head.split("\r\n");
  const match = /^GET (\S+) HTTP\/1\.1$/.exec(requestLine);
  if (!match) return reject("400 Bad Request");

  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) return reject("400 Bad Request");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const previous = headers.get(name);
    headers.set(name, previous === undefined ? value : `${previous}, ${value}`);
  }

  if (!tokens(headers.get("upgrade")).includes("websocket")) return reject("400 Bad Request");
  if (!tokens(headers.get("connection")).includes("upgrade")) return reject("400 Bad Request");
  if (headers.get("sec-websocket-version") !== "13") {
    return reject("426 Upgrade Required", "Sec-WebSocket-Version: 13\r\n");
  }
  const key = headers.get("sec-websocket-key") ?? "";
  // The key is 16 random bytes, base64-encoded: always 24 characters.
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject("400 Bad Request");
  if (options.allowOrigin && !options.allowOrigin(headers.get("origin"))) {
    return reject("403 Forbidden");
  }

  return {
    ok: true,
    request: { path: match[1] as string, headers },
    response:
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  };
}
