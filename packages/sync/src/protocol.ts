/**
 * The wire protocol: binary WebSocket messages, each a message type followed
 * by its payload, in lib0's variable-length encoding.
 *
 *   Sync       0  y-protocols sync: step 1 (my state vector), step 2 (what
 *                 you're missing), or an update
 *   Awareness  1  y-protocols awareness: cursors, selections, names
 *   Heartbeat  4  "still here"; the server answers each one with another
 *
 * Types 0 and 1 match y-websocket's, so its tools can read the traffic.
 */
import type * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { type Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as sync from "y-protocols/sync";
import type * as Y from "yjs";

/** Bumped when client and server can no longer talk to each other. */
export const PROTOCOL_VERSION = 1;

export const MessageType = {
  Sync: 0,
  Awareness: 1,
  Heartbeat: 4,
} as const;

/** Board ids: random, URL-safe, and long enough not to be guessed. */
export const BOARD_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** WebSocket close codes the server sends. 4000-4999 are for applications. */
export const CloseCode = {
  /** The client sent bytes that aren't a valid message. Retrying won't help. */
  InvalidMessage: 1007,
  /** The client couldn't keep up with what the server was sending. */
  TooSlow: 4008,
} as const;

/** Sync step 1: "here is what I have", as a state vector. */
export function syncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  sync.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** A document update, sent as it happens. */
export function syncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  sync.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** The awareness states of `clients`. A removed client is sent as a null state. */
export function awarenessMessage(awareness: Awareness, clients: readonly number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Awareness);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [...clients]));
  return encoding.toUint8Array(encoder);
}

export const HEARTBEAT: Uint8Array = Uint8Array.of(MessageType.Heartbeat);

/**
 * Answers a sync message: applies an update (step 2 or a live one) to `doc`
 * with `origin`, or replies to step 1 with the missing part. Returns the
 * sync message type and the reply, if any.
 */
export function readSync(
  decoder: decoding.Decoder,
  doc: Y.Doc,
  origin: unknown,
): { type: number; reply: Uint8Array | null } {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  const type = sync.readSyncMessage(decoder, encoder, doc, origin);
  return { type, reply: encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null };
}
