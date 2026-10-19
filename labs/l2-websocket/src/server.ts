import net from "node:net";
import {
  CloseCode,
  decodeClose,
  decodeText,
  encodeClose,
  encodeFrame,
  type Frame,
  FrameParser,
  Opcode,
  ProtocolError,
} from "./frame";
import { type HandshakeOptions, handshake, MAX_HEAD_BYTES, type UpgradeRequest } from "./handshake";

export interface WebSocketServerOptions extends HandshakeOptions {
  /** Largest message accepted, in bytes. Default 1 MiB. */
  maxPayload?: number;
  /** Ping this often, and drop a peer that hasn't answered the previous ping. Off by default. */
  heartbeatMs?: number;
  /** How long to wait for the peer to finish closing before dropping it. Default 5 s. */
  closeTimeoutMs?: number;
  onConnection: (socket: ServerWebSocket, request: UpgradeRequest) => void;
}

/** How long a client has to send its handshake. Stops slow-loris connections piling up. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** A WebSocket server on a plain TCP server. Call `listen` on the result. */
export function createWebSocketServer(options: WebSocketServerOptions): net.Server {
  return net.createServer((socket) => upgrade(socket, options));
}

function upgrade(socket: net.Socket, options: WebSocketServerOptions): void {
  let head = Buffer.alloc(0);
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", () => socket.destroy());

  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.byteLength > MAX_HEAD_BYTES) {
        socket.off("data", onData);
        socket.end(
          "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      }
      return;
    }
    socket.off("data", onData);
    const result = handshake(head.subarray(0, end).toString("latin1"), options);
    if (!result.ok) {
      socket.end(result.response);
      return;
    }
    socket.setTimeout(0);
    // Small frames should go out at once, not wait to be batched (Nagle's algorithm).
    socket.setNoDelay(true);
    socket.write(result.response);
    const ws = new ServerWebSocket(socket, options);
    options.onConnection(ws, result.request);
    // A client may send frames right behind its request, in the same packet.
    ws.receive(head.subarray(end + 4));
  };
  socket.on("data", onData);
}

export type ReadyState = "open" | "closing" | "closed";

/** The server's end of one connection, shaped like the browser's WebSocket. */
export class ServerWebSocket {
  readyState: ReadyState = "open";
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  /** Fires once the TCP connection is gone. 1006 means it ended without a close handshake. */
  onclose: ((code: number, reason: string) => void) | null = null;

  private readonly parser: FrameParser;
  private readonly maxPayload: number;
  private readonly closeTimeoutMs: number;
  /** False once we have stopped reading: after a protocol error or the peer's close frame. */
  private reading = true;
  private closeCode: number = CloseCode.Abnormal;
  private closeReason = "";
  private message: { opcode: Opcode; parts: Uint8Array[]; bytes: number } | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private awaitingPong = false;

  constructor(
    private readonly socket: net.Socket,
    options: Omit<WebSocketServerOptions, "onConnection">,
  ) {
    this.maxPayload = options.maxPayload ?? 1024 * 1024;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5000;
    this.parser = new FrameParser({ maxPayload: this.maxPayload, expectMasked: true });
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.finish());
    if (options.heartbeatMs) {
      this.heartbeat = setInterval(() => {
        // No pong since the last ping: the peer is gone, or too slow to count as here.
        if (this.awaitingPong) {
          this.socket.destroy();
          return;
        }
        this.awaitingPong = true;
        this.ping();
      }, options.heartbeatMs);
    }
  }

  /** Bytes queued in the kernel-side buffer. Grows when the peer reads slower than we send. */
  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== "open") return;
    if (typeof data === "string") this.write(Opcode.Text, new TextEncoder().encode(data));
    else this.write(Opcode.Binary, data);
  }

  ping(payload: Uint8Array = new Uint8Array(0)): void {
    if (this.readyState === "open") this.write(Opcode.Ping, payload);
  }

  /** Starts the closing handshake. `onclose` fires once the peer has answered. */
  close(code: number = CloseCode.Normal, reason = ""): void {
    if (this.readyState !== "open") return;
    this.readyState = "closing";
    this.write(Opcode.Close, encodeClose(code, reason));
    this.armCloseTimer();
  }

  /** @internal Bytes from the socket. */
  receive(chunk: Uint8Array): void {
    if (!this.reading) return;
    try {
      this.parser.write(chunk);
      for (let frame = this.parser.next(); frame && this.reading; frame = this.parser.next()) {
        this.handle(frame);
      }
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.fail(error.code, error.message);
    }
  }

  private handle(frame: Frame): void {
    if (frame.opcode === Opcode.Ping) {
      if (this.readyState === "open") this.write(Opcode.Pong, frame.payload);
      return;
    }
    if (frame.opcode === Opcode.Pong) {
      this.awaitingPong = false;
      return;
    }
    if (frame.opcode === Opcode.Close) {
      const { code, reason } = decodeClose(frame.payload);
      this.reading = false;
      this.closeCode = code;
      this.closeReason = reason;
      // Answer with the same code, unless we started the close and this is the answer.
      if (this.readyState === "open") {
        this.write(Opcode.Close, code === 1005 ? new Uint8Array(0) : encodeClose(code));
      }
      this.readyState = "closing";
      // The server closes TCP first, so the TIME_WAIT state lands on the server, not the client.
      this.socket.end();
      this.armCloseTimer();
      return;
    }

    // Text, Binary or Continuation: a message may arrive in several frames.
    if (frame.opcode !== Opcode.Continuation) {
      if (this.message)
        throw new ProtocolError(
          CloseCode.ProtocolError,
          "new message before the last one finished",
        );
      this.message = { opcode: frame.opcode, parts: [], bytes: 0 };
    }
    const message = this.message;
    if (!message)
      throw new ProtocolError(
        CloseCode.ProtocolError,
        "continuation frame with nothing to continue",
      );
    message.bytes += frame.payload.byteLength;
    if (message.bytes > this.maxPayload) {
      throw new ProtocolError(CloseCode.TooBig, `message of over ${this.maxPayload} bytes`);
    }
    message.parts.push(frame.payload);
    if (!frame.fin) return;

    this.message = null;
    const bytes =
      message.parts.length === 1
        ? (message.parts[0] as Uint8Array)
        : concat(message.parts, message.bytes);
    const data = message.opcode === Opcode.Text ? decodeText(bytes) : bytes;
    // Once the app has called close() it doesn't want more messages.
    if (this.readyState === "open") this.onmessage?.(data);
  }

  /** Fails the connection: tell the peer why, then stop reading and close. */
  private fail(code: number, reason: string): void {
    this.reading = false;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.readyState === "open")
      this.write(Opcode.Close, encodeClose(code, reason.slice(0, 120)));
    this.readyState = "closing";
    this.socket.end();
    this.armCloseTimer();
  }

  private write(opcode: Opcode, payload: Uint8Array): void {
    if (!this.socket.writableEnded) this.socket.write(encodeFrame(opcode, payload));
  }

  private armCloseTimer(): void {
    this.closeTimer ??= setTimeout(() => this.socket.destroy(), this.closeTimeoutMs);
  }

  private finish(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.reading = false;
    this.onclose?.(this.closeCode, this.closeReason);
  }
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
