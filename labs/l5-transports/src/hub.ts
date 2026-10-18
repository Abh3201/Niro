/**
 * The chat room every transport serves: posts in, numbered messages out to
 * everyone. It knows nothing about the network, so all five transports
 * share one room and their clients see each other.
 */

export interface ChatMessage {
  readonly id: number;
  readonly from: string;
  readonly text: string;
  /** When the server received it, in ms since 1970. */
  readonly sentAt: number;
}

export type Listener = (message: ChatMessage) => void;

export class ChatHub {
  private nextId = 1;
  private readonly listeners = new Set<Listener>();

  /** Numbers the post and hands it to every listener, the sender's own included. */
  post(from: string, text: string): ChatMessage {
    const message: ChatMessage = { id: this.nextId++, from, text, sentAt: Date.now() };
    for (const listener of this.listeners) listener(message);
    return message;
  }

  /** Calls `listener` with every message from now on; the result stops it. */
  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listening(): number {
    return this.listeners.size;
  }
}

/**
 * Messages as a stream to `for await` over, for server code that writes a
 * response as it goes (Connect's streaming handlers). It listens from the
 * moment it's called, not from the first read, so nothing posted in between
 * is missed. Messages queue while the reader is busy; `signal` ends it.
 */
export function messagesOf(hub: ChatHub, signal: AbortSignal): AsyncIterableIterator<ChatMessage> {
  const queue: ChatMessage[] = [];
  let wake: (() => void) | null = null;
  const stop = hub.listen((message) => {
    queue.push(message);
    wake?.();
  });
  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort);
  const end = () => {
    stop();
    signal.removeEventListener("abort", onAbort);
  };
  const iterator: AsyncIterableIterator<ChatMessage> = {
    async next() {
      for (;;) {
        if (signal.aborted) {
          end();
          return { done: true, value: undefined };
        }
        const message = queue.shift();
        if (message) return { done: false, value: message };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    },
    async return() {
      end();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

/** Sent to each client first, when its subscription is live: who's in the room. */
export function hello(hub: ChatHub): ChatMessage {
  return { id: 0, from: "room", text: `${hub.listening} here`, sentAt: Date.now() };
}
