import { Network, Simulation } from "@niro/netsim";
import { describe, expect, it } from "vitest";
import { SyncClient } from "./client";
import { runScenario } from "./fuzz";
import type { SequencedOp } from "./protocol";
import { SyncServer, type SyncServerOptions } from "./server";

/** A server and named clients on a network with a fixed 10 ms latency. */
function setup(names: readonly string[], options: SyncServerOptions = {}) {
  const sim = new Simulation(1);
  const net = new Network(sim, { latency: [10, 10] });
  const applied: SequencedOp[] = [];
  const server = new SyncServer({ ...options, onApply: (op) => applied.push(op) });
  const listen = () => net.listen("server", (c) => server.accept(c));
  listen();
  const client = (name: string) =>
    new SyncClient({
      clientId: name,
      connect: () => net.connect(name, "server"),
      schedule: (delay, fn) => sim.schedule(delay, fn),
      random: () => sim.random.next(),
    });
  const clients = names.map(client);
  sim.runUntilIdle();
  return { sim, net, server, applied, listen, clients };
}

const entries = (state: ReadonlyMap<string, unknown>) => Object.fromEntries(state);

describe("L3 sync", () => {
  it("shows a local edit at once and converges on the server's order", () => {
    const { sim, server, clients } = setup(["a", "b"]);
    const [a, b] = clients as [SyncClient, SyncClient];
    a.set("x", 1);
    b.set("x", 2);
    // Optimistic: each sees its own edit before the server answers.
    expect(a.view().get("x")).toBe(1);
    expect(b.view().get("x")).toBe(2);

    sim.runUntilIdle();
    // Both edits reach the server at the same instant. a's was sent first,
    // so the server applies it first, and b's, applied last, wins.
    expect(entries(server.state)).toEqual({ x: 2 });
    expect(entries(a.view())).toEqual({ x: 2 });
    expect(entries(b.view())).toEqual({ x: 2 });
    expect(a.unconfirmed + b.unconfirmed).toBe(0);
  });

  it("keeps edits made while offline and sends them after reconnecting", () => {
    const { sim, net, server, clients } = setup(["a", "b"]);
    const [a, b] = clients as [SyncClient, SyncClient];
    net.isolate("a");
    a.set("x", 1);
    a.set("y", 2);
    sim.advance(5000);
    expect(server.state.size).toBe(0);
    expect(a.isSynced).toBe(false);
    expect(entries(a.view())).toEqual({ x: 1, y: 2 });

    net.heal();
    sim.runUntilIdle();
    expect(entries(server.state)).toEqual({ x: 1, y: 2 });
    expect(entries(b.view())).toEqual({ x: 1, y: 2 });
  });

  it("sends a snapshot to a client that missed more than the log holds", () => {
    const { sim, net, server, clients } = setup(["a", "b"], { logLimit: 2 });
    const [a, b] = clients as [SyncClient, SyncClient];
    net.isolate("a");
    for (let i = 0; i < 5; i++) b.set(`k${i}`, i);
    sim.advance(100);
    net.heal();
    sim.runUntilIdle();
    expect(server.stats.snapshots).toBe(1);
    expect(entries(a.view())).toEqual(entries(server.state));
    expect(a.save().lastSeq).toBe(5);
  });

  it("catches up from the log when it can", () => {
    const { sim, net, server, clients } = setup(["a", "b"], { logLimit: 10 });
    const [a, b] = clients as [SyncClient, SyncClient];
    net.isolate("a");
    b.set("x", 1);
    b.set("x", null);
    sim.advance(100);
    net.heal();
    sim.runUntilIdle();
    expect(server.stats.snapshots).toBe(0);
    expect(entries(a.view())).toEqual({});
  });

  /**
   * a's edit reaches the server, but the connection dies before the echo
   * gets back. b then writes the same key. a reconnects after the log moved
   * on, so it gets a snapshot, which doesn't say whether a's edit is in it.
   */
  function lostEcho(idempotency: boolean) {
    const { sim, net, server, applied, clients } = setup(["a", "b"], { logLimit: 1, idempotency });
    const [a, b] = clients as [SyncClient, SyncClient];
    a.set("x", "a's edit");
    sim.advance(15); // applied at +10, echo due at +20
    net.isolate("a");
    b.set("x", "b's later edit");
    sim.advance(100);
    net.heal();
    sim.runUntilIdle();
    return { server, applied, a };
  }

  it("applies an edit once even when its confirmation was lost", () => {
    const { server, applied, a } = lostEcho(true);
    // The server remembered applying a's clientSeq 1 and said so in the welcome.
    expect(applied.map((op) => op.value)).toEqual(["a's edit", "b's later edit"]);
    expect(server.state.get("x")).toBe("b's later edit");
    expect(a.view().get("x")).toBe("b's later edit");
  });

  it("without the idempotency record, a retry overwrites a newer edit", () => {
    const { server, applied } = lostEcho(false);
    // a resent its edit, the server applied it again, and b's edit was lost.
    expect(applied.map((op) => op.value)).toEqual(["a's edit", "b's later edit", "a's edit"]);
    expect(server.state.get("x")).toBe("a's edit");
  });

  it("loses nothing and repeats nothing across a server crash", () => {
    const { sim, net, server, applied, listen, clients } = setup(["a", "b"]);
    const [a, b] = clients as [SyncClient, SyncClient];
    a.set("x", 1);
    sim.advance(15); // applied, echo still in flight
    net.crash("server");
    server.restart();
    a.set("y", 2);
    b.set("z", 3);
    sim.advance(4000);
    listen();
    sim.runUntilIdle();

    expect(entries(server.state)).toEqual({ x: 1, y: 2, z: 3 });
    expect(applied.map((op) => `${op.clientId}${op.clientSeq}`).sort()).toEqual(["a1", "a2", "b1"]);
    for (const c of [a, b]) expect(entries(c.view())).toEqual(entries(server.state));
  });

  it("backs off while the server is down", () => {
    const sim = new Simulation(3);
    const net = new Network(sim, { latency: [10, 10] });
    const attempts: number[] = [];
    net.onTrace = (e) => {
      if (e.kind === "connect") attempts.push(e.time);
    };
    new SyncClient({
      clientId: "a",
      connect: () => net.connect("a", "server"),
      schedule: (delay, fn) => sim.schedule(delay, fn),
      random: () => sim.random.next(),
    });
    sim.advance(60_000);
    // Retrying right after each 1 s connect timeout would be 60 attempts.
    // Backoff doubles the wait up to 10 s.
    expect(attempts.length).toBeGreaterThan(5);
    expect(attempts.length).toBeLessThan(20);
    const gaps = attempts.slice(1).map((t, i) => t - (attempts[i] as number));
    expect(gaps.at(-1)).toBeGreaterThan(gaps[0] as number);
  });
});

describe("L3 fuzz", () => {
  const seeds = Number(process.env.FUZZ_SEEDS ?? 1000);

  it("replays a seed exactly", () => {
    const lines = (seed: number) => {
      const out: string[] = [];
      const result = runScenario(seed, { log: (line) => out.push(line) });
      return { result, out };
    };
    expect(lines(42)).toEqual(lines(42));
    expect(lines(42).out).not.toEqual(lines(43).out);
  });

  const name = `converges with every edit applied exactly once, over ${seeds} random runs`;
  it(name, { timeout: Math.max(5000, seeds * 2) }, () => {
    const failures: { seed: number; violations: readonly string[] }[] = [];
    let faults = 0;
    for (let seed = 1; seed <= seeds && failures.length < 3; seed++) {
      const result = runScenario(seed);
      faults += result.faults;
      if (result.violations.length > 0) failures.push({ seed, violations: result.violations });
    }
    // Replay a failing seed with runScenario(seed, { log: console.log }).
    expect(failures).toEqual([]);
    // The runs do exercise faults, not just the happy path.
    expect(faults).toBeGreaterThan(seeds);
  });

  it("finds the bug when the server forgets what it applied", () => {
    let found: number | null = null;
    for (let seed = 1; seed <= 500 && found === null; seed++) {
      if (runScenario(seed, { idempotency: false }).violations.length > 0) found = seed;
    }
    expect(found).not.toBeNull();
  });
});
