import { USER_ID } from "@niro/doc";
import type { Engine, Point, RemotePeer } from "@niro/engine";
import type { Awareness } from "y-protocols/awareness";

/** Who you are to others on a board. Kept in this browser; there are no accounts. */
export interface Identity {
  readonly name: string;
  readonly color: string;
}

/** Someone on the board, for the avatars. */
export interface Person extends Identity {
  readonly id: number;
  readonly self: boolean;
}

/**
 * Cursor, label and selection colors. Each is dark enough for white text
 * (contrast 4.5:1 or better) and readable on light and dark boards.
 */
export const PEER_COLORS = [
  "#c2410c",
  "#b45309",
  "#15803d",
  "#0f766e",
  "#0369a1",
  "#4338ca",
  "#7e22ce",
  "#be185d",
  "#b91c1c",
] as const;

const ADJECTIVES = [
  "Amber",
  "Brave",
  "Calm",
  "Clever",
  "Curious",
  "Gentle",
  "Happy",
  "Lucky",
  "Nimble",
  "Quiet",
  "Swift",
  "Witty",
];
const ANIMALS = [
  "Badger",
  "Falcon",
  "Fox",
  "Heron",
  "Koala",
  "Lynx",
  "Otter",
  "Owl",
  "Panda",
  "Puffin",
  "Seal",
  "Wren",
];

/** Cursor positions sent per second at most. */
const CURSOR_HZ = 20;
/**
 * Most selected ids shared with others. The server drops a presence state
 * over 16 KB, which would hide your cursor too; 200 ids is about 5 KB.
 */
const MAX_SHARED_SELECTION = 200;
export const MAX_NAME_LENGTH = 32;
const COLOR = /^#[0-9a-f]{6}$/i;
const STORAGE = "niro:identity";

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;

const cleanName = (name: string) => name.trim().slice(0, MAX_NAME_LENGTH);

/** Your name and color, made up the first time and remembered after that. */
export function loadIdentity(): Identity {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
    const identity = readIdentity(stored);
    if (identity) return identity;
  } catch {
    // Unreadable or no storage: make one up.
  }
  const identity = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(PEER_COLORS) };
  saveIdentity(identity);
  return identity;
}

const USER_ID_STORAGE = "niro:user-id";

/**
 * This browser's id for reactions, made up the first time and remembered
 * (or, without storage, for this visit). Not a secret and not an account:
 * it only lets you take back your own reactions.
 */
export function loadUserId(): string {
  try {
    const stored = localStorage.getItem(USER_ID_STORAGE);
    if (stored && USER_ID.test(stored)) return stored;
  } catch {
    // No storage: an id for this visit.
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  try {
    localStorage.setItem(USER_ID_STORAGE, id);
  } catch {
    // Not remembered.
  }
  return id;
}

function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(identity));
  } catch {
    // Not remembered; it still works for this visit.
  }
}

/** Presence states come from other browsers: check everything before drawing it. */
function readIdentity(value: unknown): Identity | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, color } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof color !== "string" || !COLOR.test(color)) return null;
  const cleaned = cleanName(name);
  return cleaned ? { name: cleaned, color } : null;
}

function readPoint(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : null;
}

function readPeer(id: number, state: unknown): RemotePeer | null {
  if (typeof state !== "object" || state === null) return null;
  const { user, cursor, selection } = state as Record<string, unknown>;
  const identity = readIdentity(user);
  if (!identity) return null;
  return {
    id,
    ...identity,
    cursor: readPoint(cursor),
    selection: Array.isArray(selection)
      ? selection.filter((s): s is RemotePeer["selection"][number] => typeof s === "string")
      : [],
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Connects this user's presence (name, color, cursor, selection) and
 * everyone else's between the engine and Yjs awareness. Presence never goes
 * into the board document: it's per connection and gone when you leave.
 */
export class Presence {
  private people: readonly Person[] = [];
  private peopleSignature = "";
  private readonly listeners = new Set<() => void>();
  private engine: Engine | null = null;
  /** The cursor waiting for the next send slot; undefined when none is. */
  private pendingCursor: Point | null | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly awareness: Awareness,
    identity: Identity,
  ) {
    awareness.setLocalState({ user: identity, cursor: null, selection: [] });
    awareness.on("change", this.onChange);
    this.updatePeople();
  }

  /** Draws everyone else on `engine`, and shares this user's selection from it. */
  attach(engine: Engine): () => void {
    this.engine = engine;
    let selection = engine.getState().selection;
    const unsubscribe = engine.subscribe(() => {
      const next = engine.getState().selection;
      if (next === selection) return;
      selection = next;
      this.awareness.setLocalStateField("selection", next.slice(0, MAX_SHARED_SELECTION));
    });
    engine.setPeers(this.peers());
    return () => {
      unsubscribe();
      this.engine = null;
    };
  }

  /** For `EngineOptions.onPointerMove`: shares the cursor, at most 20 times a second. */
  readonly pointerMoved = (world: Point | null): void => {
    this.pendingCursor = world && { x: round(world.x), y: round(world.y) };
    if (this.cursorTimer !== null) return; // the next slot sends the latest
    this.sendCursor();
  };

  private sendCursor(): void {
    if (this.pendingCursor === undefined) {
      this.cursorTimer = null;
      return;
    }
    this.awareness.setLocalStateField("cursor", this.pendingCursor);
    this.pendingCursor = undefined;
    this.cursorTimer = setTimeout(() => this.sendCursor(), 1000 / CURSOR_HZ);
  }

  rename(name: string): void {
    const user = readIdentity({ ...this.identity(), name });
    if (!user) return;
    saveIdentity(user);
    this.awareness.setLocalStateField("user", user);
  }

  identity(): Identity {
    return (
      readIdentity(this.awareness.getLocalState()?.user) ?? { name: "", color: PEER_COLORS[0] }
    );
  }

  /** For `useSyncExternalStore`: everyone here, you first. Changes only when people do. */
  readonly getPeople = (): readonly Person[] => this.people;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  destroy(): void {
    if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
    this.awareness.off("change", this.onChange);
    this.listeners.clear();
  }

  private peers(): RemotePeer[] {
    const peers: RemotePeer[] = [];
    for (const [id, state] of this.awareness.getStates()) {
      if (id === this.awareness.clientID) continue;
      const peer = readPeer(id, state);
      if (peer) peers.push(peer);
    }
    return peers;
  }

  private readonly onChange = (changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    const self = this.awareness.clientID;
    const others = [...changes.added, ...changes.updated, ...changes.removed].some(
      (id) => id !== self,
    );
    // Our own cursor moving changes nothing on our screen.
    if (others) this.engine?.setPeers(this.peers());
    this.updatePeople();
  };

  private updatePeople(): void {
    const me = this.identity();
    const people: Person[] = [
      { id: this.awareness.clientID, ...me, self: true },
      ...this.peers().map(({ id, name, color }) => ({ id, name, color, self: false })),
    ];
    const signature = JSON.stringify(people);
    if (signature === this.peopleSignature) return;
    this.peopleSignature = signature;
    this.people = people;
    for (const listener of this.listeners) listener();
  }
}
