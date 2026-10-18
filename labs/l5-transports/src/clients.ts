import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import WebSocket from "ws";
import { FrameReader, frame } from "./frames";
import { ChatService, type Post, PostSchema } from "./gen/chat_pb";
import type { ChatMessage } from "./hub";
import { SseParser } from "./sse";

/**
 * A chat client for each transport, all with the same shape. `open*`
 * resolves once the server has said hello, so the client's subscription is
 * live and it will see everything posted from then on.
 */
export interface ChatClient {
  send(text: string): Promise<void>;
  /** The next message in the room, in order. */
  next(): Promise<ChatMessage>;
  close(): void;
}

/** Messages waiting to be read, and readers waiting for messages. */
class Inbox {
  private readonly messages: ChatMessage[] = [];
  private readonly readers: { resolve(m: ChatMessage): void; reject(e: unknown): void }[] = [];
  private failure: unknown = null;
  private greeted: (() => void) | null = null;
  readonly hello: Promise<void>;

  constructor() {
    this.hello = new Promise((resolve) => {
      this.greeted = resolve;
    });
  }

  put(message: ChatMessage): void {
    if (message.id === 0) return void this.greeted?.();
    const reader = this.readers.shift();
    if (reader) reader.resolve(message);
    else this.messages.push(message);
  }

  fail(error: unknown): void {
    this.failure ??= error;
    for (const reader of this.readers.splice(0)) reader.reject(error);
  }

  next(): Promise<ChatMessage> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
  }
}

/** Waits for the hello, failing if the connection fails first. */
async function greeted(inbox: Inbox, failed: Promise<never>): Promise<void> {
  await Promise.race([inbox.hello, failed]);
}

function failure(inbox: Inbox): { failed: Promise<never>; fail(error: unknown): void } {
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = (error) => {
      inbox.fail(error);
      reject(error);
    };
  });
  failed.catch(() => {});
  return { failed, fail };
}

const fromProto = (m: {
  id: bigint;
  from: string;
  text: string;
  sentAtMs: bigint;
}): ChatMessage => ({
  id: Number(m.id),
  from: m.from,
  text: m.text,
  sentAt: Number(m.sentAtMs),
});

/** WebSocket: one TCP connection, framed messages both ways. */
export async function openWebSocket(http1: string, name: string): Promise<ChatClient> {
  const inbox = new Inbox();
  const { failed, fail } = failure(inbox);
  const ws = new WebSocket(`${http1.replace(/^http/, "ws")}/ws`);
  ws.on("message", (data) => inbox.put(JSON.parse(String(data))));
  ws.on("error", fail);
  ws.on("close", () => fail(new Error("closed")));
  await greeted(inbox, failed);
  return {
    send: async (text) => ws.send(JSON.stringify({ from: name, text })),
    next: () => inbox.next(),
    close: () => ws.close(),
  };
}

/** Server-sent events down one long response, and a POST per message up. */
export async function openSse(http1: string, name: string): Promise<ChatClient> {
  const inbox = new Inbox();
  const { failed, fail } = failure(inbox);
  const abort = new AbortController();
  void (async () => {
    const response = await fetch(`${http1}/events`, { signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`events: ${response.status}`);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("closed");
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        inbox.put(JSON.parse(event.data));
      }
    }
  })().catch(fail);
  await greeted(inbox, failed);
  return {
    async send(text) {
      const response = await fetch(`${http1}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: name, text }),
      });
      if (!response.ok) throw new Error(`send: ${response.status}`);
    },
    next: () => inbox.next(),
    close: () => abort.abort(),
  };
}

/** Connect over HTTP/1.1: a streaming response for messages, a request per post. */
export async function openConnectHttp1(http1: string, name: string): Promise<ChatClient> {
  const client = createClient(
    ChatService,
    createConnectTransport({ baseUrl: http1, httpVersion: "1.1" }),
  );
  const inbox = new Inbox();
  const { failed, fail } = failure(inbox);
  const abort = new AbortController();
  void (async () => {
    for await (const message of client.watch({}, { signal: abort.signal })) {
      inbox.put(fromProto(message));
    }
    throw new Error("closed");
  })().catch(fail);
  await greeted(inbox, failed);
  return {
    async send(text) {
      await client.send({ from: name, text });
    },
    next: () => inbox.next(),
    close: () => abort.abort(),
  };
}

/**
 * Posts for a streaming request: an async iterable that yields what `push`
 * is given, until `end`.
 */
function postStream() {
  const queue: Post[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  async function* posts(): AsyncGenerator<Post> {
    for (;;) {
      const post = queue.shift();
      if (post) {
        yield post;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  }
  return {
    posts: posts(),
    push(post: Post) {
      queue.push(post);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

/**
 * Connect's `Talk` over HTTP/2: posts up and messages down on one stream.
 * `protocol` picks the wire format: Connect's own, or gRPC, which Connect
 * servers also speak.
 */
export async function openConnectHttp2(
  http2: string,
  name: string,
  protocol: "connect" | "grpc" = "connect",
): Promise<ChatClient> {
  const transport =
    protocol === "grpc"
      ? createGrpcTransport({ baseUrl: http2 })
      : createConnectTransport({ baseUrl: http2, httpVersion: "2" });
  const client = createClient(ChatService, transport);
  const inbox = new Inbox();
  const { failed, fail } = failure(inbox);
  const abort = new AbortController();
  const up = postStream();
  void (async () => {
    for await (const message of client.talk(up.posts, { signal: abort.signal })) {
      inbox.put(fromProto(message));
    }
    throw new Error("closed");
  })().catch(fail);
  await greeted(inbox, failed);
  return {
    send: async (text) => up.push(create(PostSchema, { from: name, text })),
    next: () => inbox.next(),
    close() {
      up.end();
      abort.abort();
    },
  };
}

const PROTO = fileURLToPath(new URL("../proto/chat.proto", import.meta.url));

interface GrpcMessage {
  id: number;
  from: string;
  text: string;
  sentAtMs: number;
}

/**
 * gRPC with Google's own Node library, from the .proto at run time (no
 * generated code). It talks to the Connect server above: same wire format.
 */
export async function openGrpcJs(http2: string, name: string): Promise<ChatClient> {
  const definition = protoLoader.loadSync(PROTO, { longs: Number, defaults: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    niro: { lab: { chat: { v1: { ChatService: grpc.ServiceClientConstructor } } } };
  };
  const Service = loaded.niro.lab.chat.v1.ChatService;
  const client = new Service(new URL(http2).host, grpc.credentials.createInsecure());
  const inbox = new Inbox();
  const { failed, fail } = failure(inbox);
  const call = (
    client as unknown as { Talk(): grpc.ClientDuplexStream<unknown, GrpcMessage> }
  ).Talk();
  call.on("data", (m: GrpcMessage) =>
    inbox.put({ id: m.id, from: m.from, text: m.text, sentAt: m.sentAtMs }),
  );
  call.on("error", fail);
  call.on("end", () => fail(new Error("closed")));
  await greeted(inbox, failed);
  return {
    send: async (text) => void call.write({ from: name, text }),
    next: () => inbox.next(),
    close() {
      call.cancel();
      client.close();
    },
  };
}

/** WebTransport: one HTTP/3 stream each way, over QUIC. */
export async function openWebTransport(
  url: string,
  certificateHash: Uint8Array,
  name: string,
): Promise<ChatClient> {
  const { WebTransport, quicheLoaded } = await import("@fails-components/webtransport");
  await quicheLoaded;
  const transport = new WebTransport(url, {
    serverCertificateHashes: [{ algorithm: "sha-256", value: certificateHash }],
  });
  await transport.ready;
  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  // A QUIC stream exists for the other side only once something is sent on
  // it, and the server waits for the stream to say hello: so start it with
  // an empty message.
  await writer.write(frame(new Uint8Array(0)));
  const inbox = new Inbox();
  const { failed, fail } = failure(inbox);
  void (async () => {
    const frames = new FrameReader();
    const reader = stream.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("closed");
      for (const bytes of frames.push(value))
        inbox.put(JSON.parse(new TextDecoder().decode(bytes)));
    }
  })().catch(fail);
  await greeted(inbox, failed);
  return {
    send: (text) =>
      writer.write(frame(new TextEncoder().encode(JSON.stringify({ from: name, text })))),
    next: () => inbox.next(),
    close: () => transport.close(),
  };
}
