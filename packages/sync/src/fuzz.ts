/**
 * The L3 fuzz, pointed at the real Room and SyncClient: random edits while
 * the simulated network cuts clients off and clients and the server crash.
 * Then everything heals and the run settles. Not exported from the package.
 */
import { createRandom } from "@niro/netsim";
import * as Y from "yjs";
import { contentOf, presentIn, type SimClient, World } from "./testing";

export interface ScenarioResult {
  readonly seed: number;
  readonly violations: readonly string[];
  readonly edits: number;
  readonly faults: number;
}

export function runScenario(seed: number, log: (line: string) => void = () => {}): ScenarioResult {
  // Latency varies per run, from a LAN to a bad mobile link.
  const latencyMax = createRandom(seed + 0x5eed).int(5, 200);
  const world = new World(seed, [1, latencyMax]);
  const { sim, net, server } = world;
  const random = sim.random;

  const live = new Map<string, SimClient>();
  const saved = new Map<string, Uint8Array>();
  /** Characters each client inserted into the shared text, across restarts. */
  let inserted = 0;

  const restart = (name: string) => {
    const state = saved.get(name);
    if (!state) return;
    saved.delete(name);
    live.set(name, world.client(name, { restore: state }));
    log(`${sim.now} ${name} restarts`);
  };

  const count = random.int(2, 5);
  for (let i = 0; i < count; i++) live.set(`c${i}`, world.client(`c${i}`));

  let edits = 0;
  let faults = 0;
  const steps = random.int(20, 120);
  for (let step = 0; step < steps; step++) {
    sim.advance(random.int(0, 300));
    const names = [...live.keys()];
    const roll = random.next();
    const name = names.length > 0 ? random.pick(names) : null;
    const tab = name ? live.get(name) : undefined;
    if (roll < 0.4 && tab) {
      const key = `k${random.int(0, 4)}`;
      if (random.chance(0.15)) tab.doc.getMap("m").delete(key);
      else tab.doc.getMap("m").set(key, random.int(0, 999));
      edits++;
    } else if (roll < 0.72 && tab) {
      const text = tab.doc.getText("t");
      text.insert(random.int(0, text.length), String.fromCharCode(97 + random.int(0, 25)));
      inserted++;
      edits++;
    } else if (roll < 0.8 && name) {
      net.isolate(name);
      faults++;
      log(`${sim.now} ${name} is cut off`);
    } else if (roll < 0.86) {
      net.heal();
      log(`${sim.now} network heals`);
    } else if (roll < 0.93 && name && tab) {
      // The tab's storage (IndexedDB) is durable: it comes back with everything.
      saved.set(name, Y.encodeStateAsUpdate(tab.doc));
      net.crash(name);
      tab.destroy();
      live.delete(name);
      faults++;
      log(`${sim.now} ${name} crashes`);
      sim.schedule(random.int(0, 3000), () => restart(name));
    } else if (server.up) {
      server.crash();
      faults++;
      log(`${sim.now} server crashes`);
      sim.schedule(random.int(0, 3000), () => server.restart());
    }
  }

  net.heal();
  server.restart();
  for (const name of [...saved.keys()]) restart(name);
  sim.runUntilIdle();

  const violations: string[] = [];
  const room = server.room;
  const expected = contentOf(room.doc);
  const tabs = [...live.values()];
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
  const length = room.doc.getText("t").length;
  if (length !== inserted) violations.push(`text has ${length} characters; ${inserted} were typed`);
  if (presentIn(room.awareness).join() !== everyone.join()) {
    violations.push(`server sees presence [${presentIn(room.awareness)}], expected [${everyone}]`);
  }

  for (const tab of tabs) tab.destroy();
  room.destroy();
  return { seed, violations, edits, faults };
}
