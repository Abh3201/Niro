import { USER_ID } from "@niro/doc";
import type { Engine, Point, RemotePeer, View } from "@niro/engine";
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
  /** Stepping through the frames: everyone can follow. */
  readonly presenting: boolean;
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

/** Set once you type a name yourself: then it wins over your account's name. */
const NAMED_STORAGE = "niro:named";

/**
 * Your name and color, made up the first time and remembered after that.
 * Signed in, the name is your account's, unless you've typed one yourself.
 */
export function loadIdentity(accountName: string | null = null): Identity {
  let identity: Identity | null = null;
  let named = false;
  try {
    identity = readIdentity(JSON.parse(localStorage.getItem(STORAGE) ?? "null"));
    named = localStorage.getItem(NAMED_STORAGE) === "1";
  } catch {
    // Unreadable or no storage: make one up.
  }
  identity ??= { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(PEER_COLORS) };
  const fromAccount = accountName ? cleanName(accountName) : "";
  if (fromAccount && !named) identity = { ...identity, name: fromAccount };
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

/** A view from another browser: finite numbers and a size that is more than a dot. */
function readView(value: unknown): View | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, w, h } = value as Record<string, unknown>;
  const ok = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e9;
  return ok(x) && ok(y) && ok(w) && ok(h) && w > 0 && h > 0 ? { x, y, w, h } : null;
}

function readPeer(id: number, state: unknown): RemotePeer | null {
  if (typeof state !== "object" || state === null) return null;
  const { user, cursor, selection, laser, view, presenting } = state as Record<string, unknown>;
  const identity = readIdentity(user);
  if (!identity) return null;
  return {
    id,
    ...identity,
    cursor: readPoint(cursor),
    laser: readPoint(laser),
    view: readView(view),
    presenting: presenting === true,
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
  /**
   * Changes to the cursor, laser and view waiting for the next send slot:
   * they go out together, at most 20 times a second.
   */
  private pending: { cursor?: Point | null; laser?: Point | null; view?: View | null } | null =
    null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly awareness: Awareness,
    identity: Identity,
  ) {
    awareness.setLocalState({
      user: identity,
      cursor: null,
      laser: null,
      view: null,
      presenting: false,
      selection: [],
    });
    awareness.on("change", this.onChange);
    this.updatePeople();
  }

  /** Draws everyone else on `engine`, and shares this user's selection from it. */
  attach(engine: Engine): () => void {
    this.engine = engine;
    let selection = engine.getState().selection;
    let presenting = engine.getState().presenting !== null;
    const unsubscribe = engine.subscribe(() => {
      const state = engine.getState();
      const nowPresenting = state.presenting !== null;
      if (nowPresenting !== presenting) {
        presenting = nowPresenting;
        this.awareness.setLocalStateField("presenting", presenting);
      }
      const next = state.selection;
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
    this.queue({ cursor: world && { x: round(world.x), y: round(world.y) } });
  };

  /** For `EngineOptions.onLaser`: shares the laser pointer's position, or (null) that it was let go. */
  readonly laserMoved = (world: Point | null): void => {
    this.queue({ laser: world && { x: round(world.x), y: round(world.y) } });
  };

  /** For `EngineOptions.onView`: shares the part of the board this user sees, for others to follow. */
  readonly viewChanged = (view: View | null): void => {
    this.queue({ view });
  };

  private queue(fields: NonNullable<Presence["pending"]>): void {
    this.pending = { ...this.pending, ...fields };
    if (this.cursorTimer !== null) return; // the next slot sends the latest
    this.send();
  }

  private send(): void {
    const fields = this.pending;
    if (fields === null) {
      this.cursorTimer = null;
      return;
    }
    this.pending = null;
    const state = this.awareness.getLocalState();
    if (state) this.awareness.setLocalState({ ...state, ...fields });
    this.cursorTimer = setTimeout(() => this.send(), 1000 / CURSOR_HZ);
  }

  rename(name: string): void {
    const user = readIdentity({ ...this.identity(), name });
    if (!user) return;
    saveIdentity(user);
    try {
      localStorage.setItem(NAMED_STORAGE, "1");
    } catch {
      // Not remembered.
    }
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
      { id: this.awareness.clientID, ...me, self: true, presenting: false },
      ...this.peers().map(({ id, name, color, presenting }) => ({
        id,
        name,
        color,
        self: false,
        presenting: presenting === true,
      })),
    ];
    const signature = JSON.stringify(people);
    if (signature === this.peopleSignature) return;
    this.peopleSignature = signature;
    this.people = people;
    for (const listener of this.listeners) listener();
  }
}
