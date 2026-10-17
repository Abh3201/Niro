/**
 * The little the sync code needs from a connection. The browser's WebSocket,
 * Node's `ws` and the simulated network in `@niro/netsim` all fit it with a
 * few lines of adapter, so the same Room and SyncClient run on all three.
 */
export interface Socket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued but not yet sent, when the transport knows. */
  readonly bufferedAmount?: number;
  onopen: (() => void) | null;
  onmessage: ((data: Uint8Array) => void) | null;
  /** 1006 when the connection dropped without a close frame. */
  onclose: ((code: number) => void) | null;
}

/** The shape of a standard WebSocket (browsers, Node 22+), as far as `fromWebSocket` uses it. */
export interface WebSocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
}

/** Adapts a standard WebSocket. */
export function fromWebSocket(ws: WebSocketLike): Socket {
  ws.binaryType = "arraybuffer";
  const socket: Socket = {
    // DOM typings refuse views that might be on a SharedArrayBuffer; Yjs and
    // lib0 never make those.
    send: (data) => ws.send(data as Uint8Array<ArrayBuffer>),
    close: (code, reason) => ws.close(code, reason),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.addEventListener("open", () => socket.onopen?.());
  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) socket.onmessage?.(new Uint8Array(event.data));
  });
  ws.addEventListener("close", (event) => socket.onclose?.(event.code ?? 1006));
  return socket;
}
