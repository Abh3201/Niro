import { Simulation } from "@niro/netsim";
import * as decoding from "lib0/decoding";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type FlushInfo, RoomHost, type RoomHostOptions } from "./host";
import { MessageType, ReadOnlyReason } from "./protocol";
import type { Peer } from "./room";
import { SimStorage } from "./testing";

const BOARD = "board-0123";

function setup(options: Partial<RoomHostOptions> = {}) {
  const sim = new Simulation(1);
  // A fixed 10 ms per storage call keeps the timings below exact.
  const storage = new SimStorage(sim, [10, 10]);
  const flushes: FlushInfo[] = [];
  const errors: unknown[] = [];
  const host = new RoomHost({
    storage: storage.connect(),
    schedule: (delay, fn) => sim.schedule(delay, fn),
    now: () => sim.now,
    onFlush: (info) => flushes.push(info),
    onError: (error) => errors.push(error),
    ...options,
  });
  return { sim, storage, host, flushes, errors };
}

const rows = (storage: SimStorage) => storage.boards.get(BOARD)?.length ?? 0;
const stored = (storage: SimStorage) => storage.stored(BOARD).getMap("m").toJSON();

describe("RoomHost", () => {
  it("writes 2 s after the last change, as one row", async () => {
    const { sim, storage, host } = setup();
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;

    const map = room.doc.getMap("m");
    for (let i = 0; i < 10; i++) {
      map.set(`k${i}`, i);
      await sim.advanceAsync(500);
    }
    // 4.5 s after the first change, 0.5 s after the last: nothing written yet.
    expect(rows(storage)).toBe(0);
    await sim.advanceAsync(1600);
    expect(rows(storage)).toBe(1);
    expect(Object.keys(stored(storage))).toHaveLength(10);
  });

  it("writes at most 10 s after the first unwritten change, however busy the board", async () => {
    const { sim, storage, host } = setup();
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;

    for (let i = 0; i < 30; i++) {
      room.doc.getMap("m").set("x", i);
      await sim.advanceAsync(1000);
    }
    // Changes every second for 30 s: writes start at 10 s, 20 s and 30 s,
    // and each takes 10 ms, so the third lands just after the loop.
    expect(rows(storage)).toBe(2);
    await sim.advanceAsync(20);
    expect(rows(storage)).toBe(3);
  });

  it("replaces the stored rows with one snapshot every few writes", async () => {
    const { sim, storage, host, flushes } = setup({ compactAfter: 3 });
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;

    for (let i = 0; i < 7; i++) {
      room.doc.getMap("m").set(`k${i}`, i);
      await sim.advanceAsync(3000);
    }
    expect(flushes.map((f) => f.compacted)).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(rows(storage)).toBe(2);
    expect(Object.keys(stored(storage))).toHaveLength(7);
  });

  it("keeps a failed write and tries it again", async () => {
    const { sim, storage, host, errors } = setup({ retryDelayMs: 5000 });
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;

    storage.down = true;
    room.doc.getMap("m").set("x", 1);
    await sim.advanceAsync(3000);
    expect(errors).toHaveLength(1);
    expect(host.unwritten).toBe(1);

    storage.down = false;
    await sim.advanceAsync(5000);
    expect(stored(storage)).toEqual({ x: 1 });
    expect(host.unwritten).toBe(0);
  });

  it("writes and closes a room when the last lease goes, and loads it back later", async () => {
    const { sim, storage, host } = setup();
    const first = host.acquire(BOARD);
    const second = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const a = await first;
    const b = await second;
    expect(a.room).toBe(b.room);

    a.room.doc.getMap("m").set("x", 1);
    a.release();
    a.release(); // twice is harmless
    await sim.advanceAsync(100);
    expect(host.rooms.size).toBe(1);

    b.release();
    await sim.advanceAsync(100);
    // Written at once, not 2 s later, and closed.
    expect(stored(storage)).toEqual({ x: 1 });
    expect(host.rooms.size).toBe(0);

    const again = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    expect((await again).room.doc.getMap("m").toJSON()).toEqual({ x: 1 });
  });

  it("keeps the room open for someone who arrives while it's being written", async () => {
    const { sim, host } = setup();
    const first = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const a = await first;
    a.room.doc.getMap("m").set("x", 1);

    a.release(); // the closing write takes 10 ms
    await sim.advanceAsync(5);
    const second = host.acquire(BOARD);
    await sim.advanceAsync(100);
    const b = await second;

    expect(b.room).toBe(a.room);
    expect(host.rooms.get(BOARD)).toBe(b.room);
    b.room.doc.getMap("m").set("y", 2); // still a live room
    expect(host.unwritten).toBe(1);
  });

  it("holds nothing when loading fails, and tries again on the next acquire", async () => {
    const { sim, storage, host } = setup();
    storage.down = true;
    const failed = host.acquire(BOARD);
    failed.catch(() => {});
    await sim.runUntilIdleAsync();
    await expect(failed).rejects.toThrow("storage is down");
    expect(host.rooms.size).toBe(0);

    storage.down = false;
    const retried = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    expect((await retried).room).toBeDefined();
  });

  it("goes read-only past the size limit, and says so to everyone, now and as they join", async () => {
    const { sim, host } = setup({ maxDocumentBytes: 200 });
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;
    const sent: Uint8Array[][] = [[], []];
    const peer = (i: number): Peer => ({
      send: (data) => sent[i]?.push(data),
      close: () => {},
    });
    const readOnlyNotices = (i: number) =>
      (sent[i] ?? []).filter(
        (data) => decoding.readVarUint(decoding.createDecoder(data)) === MessageType.ReadOnly,
      );

    room.join(peer(0), "edit");
    room.doc.getMap("m").set("x", "a".repeat(100));
    expect(room.readOnly).toBeNull();
    room.doc.getMap("m").set("y", "b".repeat(100));
    expect(room.readOnly).toBe(ReadOnlyReason.Full);
    expect(readOnlyNotices(0)).toHaveLength(1);

    room.join(peer(1), "edit");
    expect(readOnlyNotices(1)).toHaveLength(1);
  });

  it("measures the board before going read-only, since replaced values take little room", async () => {
    const { sim, host } = setup({ maxDocumentBytes: 1000 });
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;
    // About 20 KB of changes, to a board that stays a few hundred bytes.
    for (let i = 0; i < 200; i++) room.doc.getMap("m").set("x", `${i}`.padEnd(100, "."));
    expect(room.readOnly).toBeNull();
    expect(Y.encodeStateAsUpdate(room.doc).length).toBeLessThan(1000);

    for (let i = 0; i < 20; i++) room.doc.getMap("m").set(`k${i}`, "y".repeat(100));
    expect(room.readOnly).toBe(ReadOnlyReason.Full);
  });

  it("goes read-only when `isFull` says so, checked after every change", async () => {
    const { sim, host } = setup({ isFull: (doc) => doc.getMap("m").size >= 3 });
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;
    room.doc.getMap("m").set("a", 1);
    room.doc.getMap("m").set("b", 1);
    expect(room.readOnly).toBeNull();
    room.doc.getMap("m").set("c", 1);
    expect(room.readOnly).toBe(ReadOnlyReason.Full);
  });

  it("reports a limit check that throws, and keeps the room", async () => {
    const { sim, host, errors } = setup({
      isFull: () => {
        throw new Error("not a map");
      },
    });
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    const { room } = await lease;
    room.doc.getMap("m").set("x", 1);
    expect(room.readOnly).toBeNull();
    expect(errors.map(String)).toContain("Error: not a map");
  });

  it("writes everything on close, then refuses new rooms", async () => {
    const { sim, storage, host } = setup();
    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    (await lease).room.doc.getMap("m").set("x", 1);

    const closed = host.close();
    await sim.runUntilIdleAsync();
    await closed;
    expect(stored(storage)).toEqual({ x: 1 });
    expect(host.rooms.size).toBe(0);
    await expect(host.acquire(BOARD)).rejects.toThrow("closed");
  });

  it("loads a board stored as many rows", async () => {
    const { sim, storage, host } = setup();
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update));
    for (let i = 0; i < 5; i++) source.getMap("m").set(`k${i}`, i);
    storage.boards.set(BOARD, updates);

    const lease = host.acquire(BOARD);
    await sim.runUntilIdleAsync();
    expect((await lease).room.doc.getMap("m").toJSON()).toEqual(source.getMap("m").toJSON());
    // Loading isn't a change: nothing to write back.
    expect(host.unwritten).toBe(0);
  });
});
