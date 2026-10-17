import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import {
  awarenessMessage,
  CloseCode,
  HEARTBEAT,
  MessageType,
  readOnlyMessage,
  syncStep1,
  syncUpdate,
} from "./protocol";

export type Role = "edit" | "view";

/** One connection to a room, as the room sees it. */
export interface Peer {
  /**
   * `droppable` marks messages that may be skipped when the peer is behind
   * (cursors: the next one replaces them). Document updates never are.
   */
  send(data: Uint8Array, droppable: boolean): void;
  close(code: number, reason: string): void;
}

/** Largest awareness state accepted, as JSON characters. A cursor and a selection fit easily. */
const MAX_AWARENESS_STATE = 16 * 1024;

interface Member {
  readonly role: Role;
  /** The awareness client id this connection speaks for, once it has said. */
  clientId: number | null;
}

/**
 * Everyone editing one board: the server's copy of the document and of
 * everyone's presence. Transport-agnostic: the realtime server feeds it
 * WebSocket messages, and tests feed it the simulated network.
 *
 * - Joining starts the two-step sync: the room sends its state vector
 *   (step 1); the client answers with what the room is missing (step 2) and
 *   sends its own state vector, which the room answers the same way.
 * - Every update an editor sends is applied and relayed to everyone else
 *   (see `receiveSync` for when its sender gets it back too).
 *   Updates from view-only connections are dropped, and so is every update
 *   once the room is read-only (`setReadOnly`).
 * - Presence is relayed but never touches the document.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly stats = { updatesApplied: 0, updatesRefused: 0 };
  private readonly members = new Map<Peer, Member>();
  private readOnlyReason: string | null = null;

  constructor() {
    // The server is not a participant: it has no presence of its own.
    this.awareness.setLocalState(null);
    this.doc.on("update", this.relayUpdate);
    this.awareness.on("update", this.relayAwareness);
  }

  get size(): number {
    return this.members.size;
  }

  /** Why the room takes no more changes, or null while it does. */
  get readOnly(): string | null {
    return this.readOnlyReason;
  }

  /**
   * Stops taking changes from anyone and tells everyone why, now and as
   * they join. For limits: refusing every update after the one that crossed
   * the line keeps all copies equal, where refusing single updates wouldn't.
   */
  setReadOnly(reason: string): void {
    if (this.readOnlyReason !== null) return;
    this.readOnlyReason = reason;
    const message = readOnlyMessage(reason);
    for (const peer of this.members.keys()) peer.send(message, false);
  }

  join(peer: Peer, role: Role): void {
    this.members.set(peer, { role, clientId: null });
    // Before step 1, so the client knows by the time it's caught up.
    if (this.readOnlyReason !== null) peer.send(readOnlyMessage(this.readOnlyReason), false);
    peer.send(syncStep1(this.doc), false);
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) peer.send(awarenessMessage(this.awareness, present), true);
  }

  receive(peer: Peer, data: Uint8Array): void {
    const member = this.members.get(peer);
    if (!member) return;
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MessageType.Sync) this.receiveSync(peer, member, decoder);
      else if (type === MessageType.Awareness) this.receiveAwareness(peer, member, decoder);
      else if (type === MessageType.Heartbeat) peer.send(HEARTBEAT, true);
      // Unknown types are ignored, so newer clients can add optional ones.
    } catch {
      this.leave(peer);
      peer.close(CloseCode.InvalidMessage, "invalid message");
    }
  }

  leave(peer: Peer): void {
    const member = this.members.get(peer);
    if (!member) return;
    this.members.delete(peer);
    if (member.clientId !== null) removeAwarenessStates(this.awareness, [member.clientId], null);
  }

  destroy(): void {
    this.members.clear();
    this.awareness.off("update", this.relayAwareness);
    this.doc.off("update", this.relayUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private receiveSync(peer: Peer, member: Member, decoder: decoding.Decoder): void {
    const type = decoding.readVarUint(decoder);
    if (type === sync.messageYjsSyncStep1) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MessageType.Sync);
      sync.readSyncStep1(decoder, encoder, this.doc);
      peer.send(encoding.toUint8Array(encoder), false);
      return;
    }
    if (type !== sync.messageYjsSyncStep2 && type !== sync.messageYjsUpdate)
      throw new Error("bad sync type");
    const update = decoding.readVarUint8Array(decoder);
    if (member.role !== "edit" || this.readOnlyReason !== null) {
      this.stats.updatesRefused++;
      return;
    }
    // Relayed to everyone but its sender, who has it. Unless the room holds
    // updates waiting for something they depend on: this one may complete
    // them, and then what's relayed includes them, which the sender lacks.
    const waiting = this.doc.store.pendingStructs !== null || this.doc.store.pendingDs !== null;
    Y.applyUpdate(this.doc, update, waiting ? null : peer);
    this.stats.updatesApplied++;
  }

  /**
   * A connection speaks for one awareness client: the first one it names.
   * If another connection held that client, the newer one takes it over:
   * that's a browser reconnecting before the server noticed its old
   * connection died. Presence is not authenticated; anyone with the link
   * could claim someone's cursor, as they could edit the board.
   */
  private receiveAwareness(peer: Peer, member: Member, decoder: decoding.Decoder): void {
    const update = decoding.readVarUint8Array(decoder);
    const entries = decoding.createDecoder(update);
    const count = decoding.readVarUint(entries);
    const kept = encoding.createEncoder();
    let keptCount = 0;
    const body = encoding.createEncoder();
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(entries);
      const clock = decoding.readVarUint(entries);
      const state = decoding.readVarString(entries);
      if (member.clientId === null) {
        for (const other of this.members.values())
          if (other.clientId === clientId) other.clientId = null;
        member.clientId = clientId;
      }
      if (clientId !== member.clientId || state.length > MAX_AWARENESS_STATE) continue;
      encoding.writeVarUint(body, clientId);
      encoding.writeVarUint(body, clock);
      encoding.writeVarString(body, state);
      keptCount++;
    }
    if (keptCount === 0) return;
    encoding.writeVarUint(kept, keptCount);
    encoding.writeUint8Array(kept, encoding.toUint8Array(body));
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(kept), peer);
  }

  private readonly relayUpdate = (update: Uint8Array, origin: unknown) => {
    const message = syncUpdate(update);
    for (const peer of this.members.keys()) if (peer !== origin) peer.send(message, false);
  };

  private readonly relayAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    const message = awarenessMessage(this.awareness, changed);
    for (const peer of this.members.keys()) if (peer !== origin) peer.send(message, true);
  };
}
