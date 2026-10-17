/**
 * The L3 fuzz, pointed at the real RoomHost, Room and SyncClient: random
 * edits while the simulated network cuts clients off, clients and the
 * server crash, and storage goes down. Then everything heals and the run
 * settles. Not exported from the package.
 */
import { createRandom } from "@niro/netsim";
import * as Y from "yjs";
import { BOARD, contentOf, HostedWorld, presentIn, type SimClient } from "./testing";

export interface ScenarioResult {
  readonly seed: number;
  readonly violations: readonly string[];
  readonly edits: number;
  readonly faults: number;
}

export async function runScenario(
  seed: number,
  log: (line: string) => void = () => {},
): Promise<ScenarioResult> {
  // Network and database latency vary per run, from a LAN to a bad mobile
  // link and a busy database. Writes are debounced over a shorter window
  // than in production, so runs see many.
  const setup = createRandom(seed + 0x5eed);
  const world = new HostedWorld(
    seed,
    [1, setup.int(5, 200)],
    { flushDelayMs: 200, maxFlushDelayMs: 1000, retryDelayMs: 500, compactAfter: 5 },
    [1, setup.int(5, 400)],
  );
  const { sim, net, server, storage } = world;
  const random = sim.random;

  const live = new Map<string, SimClient>();
  const saved = new Map<string, Uint8Array>();
  /** Characters inserted into the shared text, across restarts. */
  let inserted = 0;

  /** Storage holds everything `doc` has inserted. (Map deletions aren't counted; the text has none.) */
  const isStored = (doc: Y.Doc) => {
    const stored = storage.stored(BOARD);
    const have = Y.decodeStateVector(Y.encodeStateVector(stored));
    stored.destroy();
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
      if ((have.get(client) ?? 0) < clock) return false;
    }
    return true;
  };

  const restart = (name: string) => {
    const state = saved.get(name);
    if (!state) return;
    saved.delete(name);
    live.set(name, world.client(name, { restore: state }));
    log(`${sim.now} ${name} restarts`);
  };

  const count = random.int(2, 5);
  for (let i = 0; i < count; i++) live.set(`c${i}`, world.client(`c${i}`));
  let newcomers = 0;

  let edits = 0;
  let faults = 0;
  const steps = random.int(20, 120);
  for (let step = 0; step < steps; step++) {
    await sim.advanceAsync(random.int(0, 300));
    const names = [...live.keys()];
    const roll = random.next();
    const name = names.length > 0 ? random.pick(names) : null;
    const tab = name ? live.get(name) : undefined;
    if (roll < 0.4 && tab) {
      const key = `k${random.int(0, 4)}`;
      if (random.chance(0.15)) tab.doc.getMap("m").delete(key);
      else tab.doc.getMap("m").set(key, random.int(0, 999));
      edits++;
    } else if (roll < 0.7 && tab) {
      const text = tab.doc.getText("t");
      text.insert(random.int(0, text.length), String.fromCharCode(97 + random.int(0, 25)));
      inserted++;
      edits++;
    } else if (roll < 0.73 && live.size < 6) {
      // Someone opens the link for the first time: everything must come from the server.
      const newcomer = `n${newcomers++}`;
      live.set(newcomer, world.client(newcomer));
      log(`${sim.now} ${newcomer} joins`);
    } else if (roll < 0.75 && name && tab && live.size > 1 && isStored(tab.doc)) {
      // Someone closes the tab for good, once storage has everything they
      // typed. From now on the server is the only one sure to have it.
      tab.destroy();
      live.delete(name);
      log(`${sim.now} ${name} leaves for good`);
    } else if (roll < 0.79 && name) {
      net.isolate(name);
      faults++;
      log(`${sim.now} ${name} is cut off`);
    } else if (roll < 0.83) {
      net.heal();
      log(`${sim.now} network heals`);
    } else if (roll < 0.89 && name && tab) {
      // The tab's storage (IndexedDB) is durable: it comes back with everything.
      saved.set(name, Y.encodeStateAsUpdate(tab.doc));
      net.crash(name);
      tab.destroy();
      live.delete(name);
      faults++;
      log(`${sim.now} ${name} crashes`);
      sim.schedule(random.int(0, 3000), () => restart(name));
    } else if (roll < 0.94) {
      storage.down = true;
      faults++;
      log(`${sim.now} storage goes down`);
      sim.schedule(random.int(100, 3000), () => {
        storage.down = false;
        log(`${sim.now} storage is back`);
      });
    } else if (server.up) {
      server.crash();
      faults++;
      log(`${sim.now} server crashes`);
      sim.schedule(random.int(0, 3000), () => server.restart());
    }
  }

  net.heal();
  storage.down = false;
  server.restart();
  for (const name of [...saved.keys()]) restart(name);
  await sim.runUntilIdleAsync();

  const violations: string[] = [];
  const room = server.room;
  const tabs = [...live.values()];
  if (!room) violations.push("the server has no room for the board");
  const expected = room ? contentOf(room.doc) : "";
  const everyone = tabs.map((t) => t.doc.clientID).sort((a, b) => a - b);
  for (const tab of tabs) {
    if (tab.client.status !== "online") violations.push(`${tab.name} is ${tab.client.status}`);
    const content = contentOf(tab.doc);
    if (content !== expected) violations.push(`${tab.name} has ${content}, server has ${expected}`);
    const present = presentIn(tab.awareness);
    if (present.join() !== everyone.join()) {
      violations.push(`${tab.name} sees presence [${present}], expected [${everyone}]`);
    }
  }
  const length = room?.doc.getText("t").length;
  if (length !== inserted) violations.push(`text has ${length} characters; ${inserted} were typed`);
  if (room && presentIn(room.awareness).join() !== everyone.join()) {
    violations.push(`server sees presence [${presentIn(room.awareness)}], expected [${everyone}]`);
  }

  // One last edit, and everyone leaves before it's written: closing the
  // room must write it, and storage must hold the whole board.
  const last = random.pick(tabs);
  last.doc.getText("t").insert(0, "z");
  inserted++;
  const final = contentOf(last.doc);
  for (const tab of tabs) tab.destroy();
  await sim.runUntilIdleAsync();
  if (server.host.rooms.size > 0) violations.push("the room stayed open after everyone left");
  const stored = storage.stored(BOARD);
  if (contentOf(stored) !== final) {
    violations.push(`storage has ${contentOf(stored)}, the board had ${final}`);
  }
  stored.destroy();

  // Someone opens the board later, from a browser that has never seen it.
  const latecomer = world.client("latecomer");
  await sim.runUntilIdleAsync();
  if (contentOf(latecomer.doc) !== final) {
    violations.push(`a latecomer got ${contentOf(latecomer.doc)}, expected ${final}`);
  }
  if (latecomer.doc.getText("t").length !== inserted) {
    violations.push(
      `the latecomer's text has ${latecomer.doc.getText("t").length} characters; ${inserted} were typed`,
    );
  }
  latecomer.destroy();
  await sim.runUntilIdleAsync();
  return { seed, violations, edits, faults };
}
