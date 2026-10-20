/**
 * Comments pinned to the board, kept in the same Y.Doc as the shapes but in
 * a map of their own (docs/decisions/0012-comments.md). The engine never
 * sees them: they aren't drawn on the canvas, and the shape store doesn't
 * know about them.
 *
 * Layout: `comments` is a Y.Map from thread id to a Y.Map with the pin's
 * place (`x`, `y` in world units, and optionally the shape it is on with an
 * offset from that shape's top-left corner), `resolved`, `createdAt`, and
 * `messages`, a Y.Array of plain message objects. Messages are never edited
 * once written, so two people replying at once both keep their reply.
 */
import { nanoid } from "nanoid";
import * as Y from "yjs";
import { USER_ID } from "./shape";

export const MAX_COMMENT_LENGTH = 2000;
const MAX_NAME_LENGTH = 40;
const MAX_MESSAGES = 200;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export interface CommentMessage {
  readonly id: string;
  /** The browser that wrote it (see `USER_ID`), to tell "mine" from "theirs". */
  readonly userId: string;
  readonly name: string;
  readonly color: string;
  readonly text: string;
  /** Milliseconds since the epoch, by the writer's clock. */
  readonly at: number;
}

export interface CommentThread {
  readonly id: string;
  /** Where the pin is, in world units; used when it isn't on a shape, or the shape is gone. */
  readonly x: number;
  readonly y: number;
  /** The shape the pin follows, with the pin's offset from its top-left corner. */
  readonly shape: string | null;
  readonly ox: number;
  readonly oy: number;
  readonly resolved: boolean;
  readonly createdAt: number;
  /** Oldest first; never empty. */
  readonly messages: readonly CommentMessage[];
}

export interface NewMessage {
  readonly userId: string;
  readonly name: string;
  readonly color: string;
  readonly text: string;
}

export interface NewThread {
  readonly x: number;
  readonly y: number;
  readonly shape?: { readonly id: string; readonly ox: number; readonly oy: number } | undefined;
}

export interface CommentStore {
  /** Every thread, oldest first. The same array until something changes. */
  threads(): readonly CommentThread[];
  subscribe(listener: () => void): () => void;
  /** Starts a thread with its first message; returns its id, or null when the text is empty or the store is read-only. */
  add(thread: NewThread, message: NewMessage): string | null;
  reply(threadId: string, message: NewMessage): boolean;
  setResolved(threadId: string, resolved: boolean): void;
  remove(threadId: string): void;
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

const newId = (): string => nanoid(20);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e9;

const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e15;

/** A message from the document, or null when a peer wrote something that isn't one. */
function readMessage(value: unknown): CommentMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (
    typeof m.id !== "string" ||
    !ID.test(m.id) ||
    typeof m.userId !== "string" ||
    !USER_ID.test(m.userId) ||
    typeof m.name !== "string" ||
    typeof m.color !== "string" ||
    !COLOR.test(m.color) ||
    typeof m.text !== "string" ||
    !timestamp(m.at)
  )
    return null;
  return {
    id: m.id,
    userId: m.userId,
    name: m.name.slice(0, MAX_NAME_LENGTH),
    color: m.color,
    text: m.text.slice(0, MAX_COMMENT_LENGTH),
    at: m.at,
  };
}

function readThread(id: string, value: unknown): CommentThread | null {
  if (!ID.test(id) || !(value instanceof Y.Map)) return null;
  const x = value.get("x");
  const y = value.get("y");
  const rawMessages = value.get("messages");
  if (!finite(x) || !finite(y) || !(rawMessages instanceof Y.Array)) return null;
  const messages = (rawMessages.toJSON() as unknown[])
    .slice(0, MAX_MESSAGES)
    .map(readMessage)
    .filter((m): m is CommentMessage => m !== null);
  // A thread with nothing readable in it has nothing to show.
  if (messages.length === 0) return null;
  const shape = value.get("shape");
  const ox = value.get("ox");
  const oy = value.get("oy");
  const createdAt = value.get("createdAt");
  return {
    id,
    x,
    y,
    shape: typeof shape === "string" && ID.test(shape) && finite(ox) && finite(oy) ? shape : null,
    ox: finite(ox) ? ox : 0,
    oy: finite(oy) ? oy : 0,
    resolved: value.get("resolved") === true,
    createdAt: timestamp(createdAt) ? createdAt : (messages[0]?.at ?? 0),
    messages,
  };
}

export function createCommentStore(doc: Y.Doc, options: { readOnly?: boolean } = {}): CommentStore {
  const map = doc.getMap<Y.Map<unknown>>("comments");
  let readOnly = options.readOnly ?? false;
  let cached: readonly CommentThread[] | null = null;
  const listeners = new Set<() => void>();

  const onChange = () => {
    cached = null;
    for (const listener of listeners) listener();
  };
  map.observeDeep(onChange);

  const clean = (message: NewMessage) => ({
    id: newId(),
    userId: message.userId,
    name: message.name.slice(0, MAX_NAME_LENGTH),
    color: message.color,
    text: message.text.trim().slice(0, MAX_COMMENT_LENGTH),
    at: Date.now(),
  });
  const valid = (message: ReturnType<typeof clean>) =>
    message.text !== "" && USER_ID.test(message.userId) && COLOR.test(message.color);

  return {
    threads() {
      if (!cached) {
        const threads: CommentThread[] = [];
        for (const [id, value] of map) {
          const thread = readThread(id, value);
          if (thread) threads.push(thread);
        }
        threads.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
        cached = threads;
      }
      return cached;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(thread, message) {
      const first = clean(message);
      if (readOnly || !valid(first) || !finite(thread.x) || !finite(thread.y)) return null;
      const id = newId();
      const value = new Y.Map<unknown>();
      doc.transact(() => {
        value.set("x", thread.x);
        value.set("y", thread.y);
        if (thread.shape && ID.test(thread.shape.id)) {
          value.set("shape", thread.shape.id);
          value.set("ox", thread.shape.ox);
          value.set("oy", thread.shape.oy);
        }
        value.set("resolved", false);
        value.set("createdAt", first.at);
        const messages = new Y.Array<unknown>();
        messages.push([first]);
        value.set("messages", messages);
        map.set(id, value);
      });
      return id;
    },
    reply(threadId, message) {
      const thread = map.get(threadId);
      const messages = thread?.get("messages");
      const next = clean(message);
      if (readOnly || !(messages instanceof Y.Array) || !valid(next)) return false;
      if (messages.length >= MAX_MESSAGES) return false;
      messages.push([next]);
      return true;
    },
    setResolved(threadId, resolved) {
      const thread = map.get(threadId);
      if (readOnly || !thread || (thread.get("resolved") === true) === resolved) return;
      thread.set("resolved", resolved);
    },
    remove(threadId) {
      if (!readOnly && map.has(threadId)) map.delete(threadId);
    },
    setReadOnly(value) {
      readOnly = value;
    },
    destroy() {
      map.unobserveDeep(onChange);
      listeners.clear();
    },
  };
}
