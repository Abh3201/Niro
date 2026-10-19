import { Simulation } from "@niro/netsim";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { AccessDenied, SyncClient } from "./client";
import { runScenario } from "./fuzz";
import { MessageType, ReadOnlyReason, syncUpdate } from "./protocol";
import { MAX_PENDING_BYTES, type Peer, type Role, Room } from "./room";
import type { Socket } from "./socket";
import { contentOf, presentIn, World } from "./testing";

describe("Room and SyncClient", () => {
  it("converge, and a late joiner catches up", () => {
    const world = new World(1);
    const a = world.client("a");
    const b = world.client("b");
    a.doc.getMap("m").set("x", 1);
    b.doc.getText("t").insert(0, "hi");
    world.sim.runUntilIdle();
    expect(contentOf(a.doc)).toBe(contentOf(b.doc));
    expect(a.client.status).toBe("online");

    const c = world.client("c");
    world.sim.runUntilIdle();
    expect(contentOf(c.doc)).toBe('{"m":{"x":1},"t":"hi"}');
  });

  it("merges edits made on both sides of a partition", () => {
    const world = new World(2);
    const a = world.client("a");
    const b = world.client("b");
    world.sim.runUntilIdle();
    world.net.isolate("a");
    world.sim.advance(3000);
    expect(a.client.status).not.toBe("online");
    a.doc.getText("t").insert(0, "offline ");
    b.doc.getText("t").insert(0, "online");
    world.sim.advance(1000);
    expect(b.doc.getText("t").toString()).toBe("online");

    world.net.heal();
    world.sim.runUntilIdle();
    for (const tab of [a, b])
      expect(tab.doc.getText("t").toString()).toMatch(/^(offline online|onlineoffline )$/);
    expect(contentOf(a.doc)).toBe(contentOf(b.doc));
  });

  it("restores the room from its clients after the server loses it", () => {
    const world = new World(3);
    const a = world.client("a");
    const b = world.client("b");
    a.doc.getMap("m").set("x", 1);
    world.sim.runUntilIdle();
    world.server.crash();
    b.doc.getMap("m").set("y", 2);
    world.sim.advance(2000);
    world.server.restart();
    world.sim.runUntilIdle();
    expect(world.server.room.doc.getMap("m").toJSON()).toEqual({ x: 1, y: 2 });
    expect(contentOf(a.doc)).toBe(contentOf(world.server.room.doc));
  });

  it("says when the room goes read-only, before a newcomer is caught up, and stops taking changes", () => {
    const world = new World(5);
    const a = world.client("a");
    a.doc.getMap("m").set("x", 1);
    world.sim.runUntilIdle();
    world.server.room.setReadOnly(ReadOnlyReason.Full);
    world.sim.runUntilIdle();
    expect(a.client.readOnly).toBe("full");

    const b = world.client("b");
    let readOnlyWhenOnline: string | null = null;
    b.client.subscribe((status) => {
      if (status === "online") readOnlyWhenOnline = b.client.readOnly;
    });
    world.sim.runUntilIdle();
    expect(readOnlyWhenOnline).toBe("full");

    a.doc.getMap("m").set("x", 2);
    world.sim.runUntilIdle();
    expect(world.server.room.doc.getMap("m").get("x")).toBe(1);
    expect(b.doc.getMap("m").get("x")).toBe(1);

    // A room that isn't read-only after a reconnect (the limit was raised) says nothing: writable again.
    world.server.crash();
    world.sim.advance(1000);
    world.server.restart();
    world.sim.runUntilIdle();
    expect(a.client.readOnly).toBeNull();
    expect(b.client.readOnly).toBeNull();
  });

  it("relays edits to viewers but refuses theirs", () => {
    const world = new World(4);
    const editor = world.client("editor");
    const viewer = world.client("viewer");
    editor.doc.getMap("m").set("x", 1);
    world.sim.runUntilIdle();
    expect(viewer.doc.getMap("m").get("x")).toBe(1);

    // A modified client could still send edits; the room must drop them.
    viewer.doc.getMap("m").set("x", 666);
    world.sim.runUntilIdle();
    expect(world.server.room.doc.getMap("m").get("x")).toBe(1);
    expect(editor.doc.getMap("m").get("x")).toBe(1);
    expect(world.server.room.stats.updatesRefused).toBeGreaterThan(0);
  });

  it("shows who is here, and forgets people who leave or when we disconnect", () => {
    const world = new World(5);
    const a = world.client("a");
    const b = world.client("b");
    world.sim.runUntilIdle();
    expect(presentIn(a.awareness)).toEqual([a.doc.clientID, b.doc.clientID]);

    b.awareness.setLocalStateField("cursor", { x: 10, y: 20 });
    world.sim.runUntilIdle();
    expect(a.awareness.getStates().get(b.doc.clientID)).toEqual({
      name: "b",
      cursor: { x: 10, y: 20 },
    });

    world.net.isolate("a");
    // Not runUntilIdle: a cut-off client keeps retrying.
    world.sim.advance(5000);
    // A disconnected client can't know who is still there, so it shows nobody.
    expect(presentIn(a.awareness)).toEqual([a.doc.clientID]);
    world.net.heal();
    world.sim.runUntilIdle();
    expect(presentIn(a.awareness)).toEqual([a.doc.clientID, b.doc.clientID]);

    b.destroy();
    world.sim.runUntilIdle();
    expect(presentIn(a.awareness)).toEqual([a.doc.clientID]);
  });
});

type FakePeer = Peer & { readonly sent: Uint8Array[]; closed: number | null };

/** A room with fake peers that record what they're sent. */
function roomWithPeers<const R extends readonly Role[]>(...roles: R) {
  const room = new Room();
  const peers = roles.map((role) => {
    const peer: FakePeer = {
      sent: [],
      closed: null,
      send: (data) => peer.sent.push(data),
      close: (code) => {
        peer.closed = code;
      },
    };
    room.join(peer, role);
    return peer;
  });
  return { room, peers: peers as { [K in keyof R]: FakePeer } };
}

/** An awareness message for one client, encoded by hand. */
function presence(clientId: number, state: unknown, clock = 1): Uint8Array {
  const entries = encoding.createEncoder();
  encoding.writeVarUint(entries, 1);
  encoding.writeVarUint(entries, clientId);
  encoding.writeVarUint(entries, clock);
  encoding.writeVarString(entries, JSON.stringify(state));
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, MessageType.Awareness);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(entries));
  return encoding.toUint8Array(message);
}

describe("Room", () => {
  it("lets a connection speak for one presence, and a reconnect take it over", () => {
    const { room, peers } = roomWithPeers("edit", "view", "edit");
    const [a, b, aAgain] = peers;
    room.receive(a, presence(1, { name: "a" }));
    room.receive(b, presence(2, { name: "b" }));
    // A second id from the same connection is ignored.
    room.receive(b, presence(3, { name: "b again" }));
    expect(presentIn(room.awareness)).toEqual([1, 2]);

    // a reconnects before the server notices its first connection died.
    room.receive(aAgain, presence(1, { name: "a" }, 2));
    room.leave(a);
    expect(room.awareness.getStates().get(1)).toEqual({ name: "a" });
    room.leave(aAgain);
    expect(presentIn(room.awareness)).toEqual([2]);
    room.destroy();
  });

  it("closes a connection that sends malformed messages", () => {
    const { room, peers } = roomWithPeers("edit", "edit");
    const [a, b] = peers;
    room.receive(a, Uint8Array.of(MessageType.Sync, 2, 200)); // claims 200 bytes, has none
    room.receive(b, Uint8Array.of(MessageType.Sync, 9)); // no such sync message
    expect([a.closed, b.closed]).toEqual([1007, 1007]);
    expect(room.size).toBe(0);
    room.destroy();
  });

  it("answers heartbeats and ignores message types it doesn't know", () => {
    const { room, peers } = roomWithPeers("edit");
    const [a] = peers;
    a.sent.length = 0;
    room.receive(a, Uint8Array.of(MessageType.Heartbeat));
    room.receive(a, Uint8Array.of(42));
    expect(a.sent).toEqual([Uint8Array.of(MessageType.Heartbeat)]);
    expect(a.closed).toBeNull();
    room.destroy();
  });

  it("relays an editor's update to everyone else, not back to the sender", () => {
    const { room, peers } = roomWithPeers("edit", "view");
    const [a, viewer] = peers;
    a.sent.length = 0;
    viewer.sent.length = 0;
    const doc = new Y.Doc();
    doc.getMap("m").set("x", 1);
    room.receive(a, syncUpdate(Y.encodeStateAsUpdate(doc)));
    expect(room.doc.getMap("m").get("x")).toBe(1);
    expect(a.sent).toEqual([]);
    expect(viewer.sent).toHaveLength(1);
    room.destroy();
  });

  it("sends an update back to its sender too when it completes edits the room was holding", () => {
    // Two edits by one person, the second built on the first, reach the
    // room out of order from two connections (a browser restored the second
    // from its own storage). The room holds the second until the first
    // arrives; then it applies both, and the first one's sender lacks the second.
    const { room, peers } = roomWithPeers("edit", "edit");
    const [a, b] = peers;
    const author = new Y.Doc();
    const updates: Uint8Array[] = [];
    author.on("update", (update: Uint8Array) => updates.push(update));
    author.getText("t").insert(0, "a");
    author.getText("t").insert(1, "b");
    const [first, second] = updates as [Uint8Array, Uint8Array];

    room.receive(a, syncUpdate(second));
    expect(room.doc.getText("t").toString()).toBe("");
    b.sent.length = 0;
    room.receive(b, syncUpdate(first));
    expect(room.doc.getText("t").toString()).toBe("ab");

    const copy = new Y.Doc();
    Y.applyUpdate(copy, first);
    applySent(copy, b.sent);
    expect(copy.getText("t").toString()).toBe("ab");
    room.destroy();
  });
});

describe("Room limits", () => {
  it("closes a connection whose updates pile up waiting for ones that never arrive", () => {
    const { room, peers } = roomWithPeers("edit", "edit");
    const [a, b] = peers;
    // Each update is built on an edit the room never gets, so it's held.
    const held = (i: number) => {
      const author = new Y.Doc();
      author.clientID = 1000 + i;
      const map = author.getMap("m");
      map.set("first", 1);
      const before = Y.encodeStateVector(author);
      map.set("big", "x".repeat(256 * 1024));
      return syncUpdate(Y.encodeStateAsUpdate(author, before));
    };
    let i = 0;
    while (a.closed === null && i < 64) room.receive(a, held(i++));
    expect(i * 256 * 1024).toBeGreaterThanOrEqual(MAX_PENDING_BYTES);
    expect(i).toBeLessThan(64);
    expect(a.closed).toBe(1007);
    expect(room.doc.store.pendingStructs).toBeNull();
    // The others carry on.
    const doc = new Y.Doc();
    doc.getMap("m").set("x", 1);
    room.receive(b, syncUpdate(Y.encodeStateAsUpdate(doc)));
    expect(room.doc.getMap("m").get("x")).toBe(1);
    expect(b.closed).toBeNull();
    room.destroy();
  });
});

/** Applies the document updates among `messages` to `doc`. */
function applySent(doc: Y.Doc, messages: readonly Uint8Array[]): void {
  for (const message of messages) {
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== MessageType.Sync) continue;
    decoding.readVarUint(decoder); // step 2 or update: both carry an update
    Y.applyUpdate(doc, decoding.readVarUint8Array(decoder));
  }
}

/** A socket that opens and then hears nothing, like a connection to a frozen server. */
function silentSocket(sim: Simulation) {
  const socket = {
    sent: 0,
    closed: false as boolean,
    send() {
      socket.sent++;
    },
    close() {
      socket.closed = true;
    },
    onopen: null as (() => void) | null,
    onmessage: null as ((data: Uint8Array) => void) | null,
    onclose: null as ((code: number) => void) | null,
  } satisfies Socket & { sent: number; closed: boolean };
  sim.schedule(10, () => socket.onopen?.());
  return socket;
}

describe("SyncClient connection handling", () => {
  const setup = (sim: Simulation, connect: () => Socket, heartbeatMs = 0) => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const client = new SyncClient({
      doc,
      awareness,
      connect,
      schedule: (delay, fn) => sim.schedule(delay, fn),
      random: () => 0.5,
      heartbeatMs,
    });
    const done = () => {
      client.destroy();
      awareness.destroy();
    };
    return { client, done };
  };

  it("gives up on a connection that has gone silent, and reconnects", () => {
    const sim = new Simulation(1);
    const sockets: ReturnType<typeof silentSocket>[] = [];
    const { done } = setup(
      sim,
      () => {
        const socket = silentSocket(sim);
        sockets.push(socket);
        return socket;
      },
      1000,
    );
    sim.advance(3500);
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    done();
  });

  it("stops for good when access is denied", () => {
    const sim = new Simulation(1);
    let attempts = 0;
    const { client, done } = setup(sim, () => {
      attempts++;
      throw new AccessDenied("bad link");
    });
    sim.advance(60_000);
    expect(client.status).toBe("denied");
    expect(attempts).toBe(1);
    done();
  });

  it("backs off further after each failure, up to a ceiling", () => {
    const sim = new Simulation(1);
    const attempts: number[] = [];
    const { client, done } = setup(sim, () => {
      attempts.push(sim.now);
      throw new Error("network down");
    });
    sim.advance(120_000);
    expect(client.status).toBe("offline");
    const gaps = attempts.slice(1).map((t, i) => t - (attempts[i] as number));
    // random() is 0.5, so each wait is 3/4 of the ceiling: 375, 750, 1500 ... then 11,250.
    expect(gaps.slice(0, 3)).toEqual([375, 750, 1500]);
    expect(Math.max(...gaps)).toBe(11_250);
    done();
  });
});

describe("Room and SyncClient fuzz", () => {
  const seeds = Number(process.env.FUZZ_SEEDS ?? 1000);

  it("replays a seed exactly", async () => {
    const trace = async (seed: number) => {
      const lines: string[] = [];
      const result = await runScenario(seed, (line) => lines.push(line));
      return { result, lines };
    };
    expect(await trace(7)).toEqual(await trace(7));
  });

  const name = `converges, loses no edit, stores everything and shows the right presence, over ${seeds} random runs`;
  it(name, { timeout: Math.max(10_000, seeds * 50) }, async () => {
    const failures: { seed: number; violations: readonly string[] }[] = [];
    let faults = 0;
    for (let seed = 1; seed <= seeds && failures.length < 3; seed++) {
      const result = await runScenario(seed);
      faults += result.faults;
      if (result.violations.length > 0) failures.push({ seed, violations: result.violations });
    }
    // Replay a failing seed with runScenario(seed, console.log).
    expect(failures).toEqual([]);
    expect(faults).toBeGreaterThan(seeds);
  });
});
