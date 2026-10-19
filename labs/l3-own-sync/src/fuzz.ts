import { Network, Simulation } from "@niro/netsim";
import { type ClientState, SyncClient } from "./client";
import type { SequencedOp, Value } from "./protocol";
import { SyncServer } from "./server";

export interface ScenarioOptions {
  /** Passed to the server. Turn it off to watch the fuzz catch the bug. */
  idempotency?: boolean;
  /** Receives a line per edit and fault, to read what a failing seed did. */
  log?: (line: string) => void;
}

export interface ScenarioResult {
  readonly seed: number;
  /** Broken invariants. Empty when the run was correct. */
  readonly violations: readonly string[];
  readonly clients: number;
  readonly edits: number;
  readonly faults: number;
  /** Virtual time until everything settled, in ms. */
  readonly duration: number;
}

const SERVER = "server";

/**
 * One random run: a server and 2 to 5 clients editing a handful of keys while
 * the network partitions, clients crash and restart, and the server crashes
 * and restarts. Then every fault heals and the run settles. Everything,
 * including the network's latency, comes from `seed`, so a failing seed
 * replays exactly.
 *
 * Invariants checked once it settles:
 * - every client sees exactly the server's state, with nothing unconfirmed;
 * - every edit was applied exactly once, in the order its client made it;
 * - no client or server saw a sequence gap.
 */
export function runScenario(seed: number, options: ScenarioOptions = {}): ScenarioResult {
  const sim = new Simulation(seed);
  const random = sim.random;
  const log = options.log ?? (() => {});
  const net = new Network(sim, { latency: [1, random.int(5, 150)] });

  const applied: SequencedOp[] = [];
  const server = new SyncServer({
    logLimit: random.int(1, 40),
    idempotency: options.idempotency ?? true,
    onApply: (op) => applied.push(op),
  });
  let serverUp = true;
  const startServer = () => {
    if (serverUp) return;
    serverUp = true;
    server.restart();
    net.listen(SERVER, (c) => server.accept(c));
    log(`${sim.now} server restarts`);
  };
  net.listen(SERVER, (c) => server.accept(c));

  const live = new Map<string, SyncClient>();
  const crashed = new Map<string, ClientState>();
  const startClient = (name: string, restore?: ClientState) => {
    live.set(
      name,
      new SyncClient({
        clientId: name,
        connect: () => net.connect(name, SERVER),
        schedule: (delay, fn) => sim.schedule(delay, fn),
        random: () => random.next(),
        ...(restore ? { restore } : {}),
      }),
    );
  };
  const restartClient = (name: string) => {
    const saved = crashed.get(name);
    if (!saved) return;
    crashed.delete(name);
    startClient(name, saved);
    log(`${sim.now} ${name} restarts`);
  };

  const clientCount = random.int(2, 5);
  for (let i = 0; i < clientCount; i++) startClient(`c${i}`);

  let edits = 0;
  let faults = 0;
  const steps = random.int(20, 150);
  for (let step = 0; step < steps; step++) {
    sim.advance(random.int(0, 250));
    const names = [...live.keys()];
    const roll = random.next();
    if (roll < 0.72 && names.length > 0) {
      const name = random.pick(names);
      const key = `k${random.int(0, 4)}`;
      const value: Value = random.chance(0.15) ? null : random.int(0, 999);
      live.get(name)?.set(key, value);
      edits++;
      log(`${sim.now} ${name} sets ${key}=${value}`);
    } else if (roll < 0.8 && names.length > 0) {
      const name = random.pick(names);
      net.isolate(name);
      faults++;
      log(`${sim.now} ${name} is cut off`);
    } else if (roll < 0.86) {
      net.heal();
      log(`${sim.now} network heals`);
    } else if (roll < 0.93 && names.length > 0) {
      // The client's storage is durable: it comes back with everything it had.
      const name = random.pick(names);
      const client = live.get(name);
      if (!client) continue;
      crashed.set(name, client.save());
      client.kill();
      live.delete(name);
      net.crash(name);
      faults++;
      log(`${sim.now} ${name} crashes`);
      sim.schedule(random.int(0, 3000), () => restartClient(name));
    } else if (serverUp) {
      serverUp = false;
      net.crash(SERVER);
      faults++;
      log(`${sim.now} server crashes`);
      sim.schedule(random.int(0, 3000), startServer);
    }
  }

  // Heal everything and let it settle.
  net.heal();
  startServer();
  for (const name of [...crashed.keys()]) restartClient(name);
  sim.runUntilIdle();

  return {
    seed,
    violations: check(server, [...live.values()], applied),
    clients: clientCount,
    edits,
    faults,
    duration: sim.now,
  };
}

function check(
  server: SyncServer,
  clients: readonly SyncClient[],
  applied: readonly SequencedOp[],
): string[] {
  const violations: string[] = [];
  const expected = show(server.state);
  if (server.gaps > 0) violations.push(`server saw ${server.gaps} clientSeq gap(s)`);

  for (const client of clients) {
    const id = client.clientId;
    if (!client.isSynced) violations.push(`${id} never reconnected`);
    if (client.unconfirmed > 0)
      violations.push(`${id} has ${client.unconfirmed} unconfirmed edit(s)`);
    for (const error of client.errors) violations.push(`${id}: ${error}`);
    const seen = client.save().lastSeq;
    if (seen !== server.lastSeq)
      violations.push(`${id} is at seq ${seen}, server at ${server.lastSeq}`);
    const view = show(client.view());
    if (view !== expected) violations.push(`${id} sees ${view}, server has ${expected}`);

    // Exactly once and in order: the server applied clientSeq 1, 2, ..., opsMade.
    const seqs = applied.filter((op) => op.clientId === id).map((op) => op.clientSeq);
    const exact = seqs.length === client.opsMade && seqs.every((s, i) => s === i + 1);
    if (!exact) {
      violations.push(
        `${id} made ${client.opsMade} edit(s); server applied clientSeqs [${seqs.join(",")}]`,
      );
    }
  }
  return violations;
}

const show = (state: ReadonlyMap<string, Value>) =>
  [...state]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "(empty)";
