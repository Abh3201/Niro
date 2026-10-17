import { describe, expect, it } from "vitest";
import { type Connection, Network, type Payload } from "./network";
import { createRandom } from "./random";
import { Simulation } from "./simulation";

/** A server that records what it receives and can reply. */
function server(net: Network, name = "server") {
  const received: string[] = [];
  const connections: Connection[] = [];
  net.listen(name, (c) => {
    connections.push(c);
    c.onmessage = (data) => received.push(String(data));
  });
  return { received, connections };
}

function client(net: Network, from: string, to = "server") {
  const c = net.connect(from, to);
  const log: string[] = [];
  c.onopen = () => log.push("open");
  c.onmessage = (data: Payload) => log.push(`msg:${String(data)}`);
  c.onclose = () => log.push("close");
  return { c, log };
}

describe("Simulation", () => {
  it("runs events in time order, ties in scheduling order", () => {
    const sim = new Simulation(1);
    const order: string[] = [];
    sim.schedule(20, () => order.push("b"));
    sim.schedule(10, () => order.push("a1"));
    sim.schedule(10, () => order.push("a2"));
    sim.schedule(5, () => sim.schedule(0, () => order.push("nested")));
    sim.runUntilIdle();
    expect(order).toEqual(["nested", "a1", "a2", "b"]);
    expect(sim.now).toBe(20);
  });

  it("cancels events and stops runaway loops", () => {
    const sim = new Simulation(1);
    let ran = false;
    sim.schedule(1, () => {
      ran = true;
    })();
    sim.runUntilIdle();
    expect(ran).toBe(false);

    const forever = () => sim.schedule(1, forever);
    forever();
    expect(() => sim.runUntilIdle(1000)).toThrow(/still busy/);
  });
});

describe("createRandom", () => {
  it("repeats for a seed and differs across seeds", () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const c = createRandom(43);
    const seq = (r: typeof a) => Array.from({ length: 5 }, () => r.next());
    const first = seq(a);
    expect(seq(b)).toEqual(first);
    expect(seq(c)).not.toEqual(first);
    for (const x of first) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe("Network connections", () => {
  it("open, then deliver in order with no loss despite random latency", () => {
    const sim = new Simulation(7);
    const net = new Network(sim, { latency: [1, 100] });
    const s = server(net);
    const { c, log } = client(net, "alice");
    c.onopen = () => {
      log.push("open");
      for (let i = 0; i < 200; i++) c.send(String(i));
    };
    sim.runUntilIdle();
    expect(log).toEqual(["open"]);
    expect(s.received).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
  });

  it("closes gracefully: queued messages arrive before the other end's onclose", () => {
    const sim = new Simulation(3);
    const net = new Network(sim);
    const events: string[] = [];
    net.listen("server", (conn) => {
      conn.onmessage = (d) => events.push(`server got ${String(d)}`);
      conn.onclose = () => events.push("server close");
    });
    const c = net.connect("alice", "server");
    c.onopen = () => {
      c.send("a");
      c.send("b");
      c.close();
    };
    c.onclose = () => events.push("client close");
    sim.runUntilIdle();
    expect(events).toEqual(["server got a", "server got b", "server close", "client close"]);
  });

  it("refuses a connection to a node that isn't listening", () => {
    const sim = new Simulation(1);
    const net = new Network(sim);
    const { log } = client(net, "alice", "nobody");
    sim.runUntilIdle();
    expect(log).toEqual(["close"]);
  });

  it("breaks connections across a partition and loses messages in flight", () => {
    const sim = new Simulation(5);
    const net = new Network(sim, { latency: [10, 10] });
    const s = server(net);
    const { c, log } = client(net, "alice");
    sim.runUntilIdle();
    c.send("before");
    sim.advance(5); // still in flight
    net.partition(["alice"], ["server"]);
    c.send("during");
    sim.runUntilIdle();
    expect(s.received).toEqual([]);
    expect(log).toEqual(["open", "close"]);

    // Healing doesn't revive the old connection, but a new one works.
    net.heal();
    const again = client(net, "alice");
    again.c.onopen = () => again.c.send("after");
    sim.runUntilIdle();
    expect(s.received).toEqual(["after"]);
  });

  it("can't connect into a partition", () => {
    const sim = new Simulation(1);
    const net = new Network(sim);
    server(net);
    net.isolate("server");
    const { log } = client(net, "alice");
    sim.runUntilIdle();
    expect(log).toEqual(["close"]);
  });

  it("a crashed node gets no callbacks; its peers notice", () => {
    const sim = new Simulation(9);
    const net = new Network(sim);
    const serverEvents: string[] = [];
    net.listen("server", (conn) => {
      conn.onclose = () => serverEvents.push("close");
    });
    const { log } = client(net, "alice");
    sim.runUntilIdle();
    net.crash("alice");
    sim.runUntilIdle();
    expect(log).toEqual(["open"]);
    expect(serverEvents).toEqual(["close"]);
  });
});

describe("Network datagrams", () => {
  it("drop, duplicate and reorder at roughly the configured rates", () => {
    const sim = new Simulation(11);
    const net = new Network(sim, { latency: [1, 200], dropRate: 0.2, duplicateRate: 0.1 });
    const got: number[] = [];
    net.onDatagram("b", (d) => got.push(Number(d)));
    const n = 5000;
    for (let i = 0; i < n; i++) net.sendDatagram("a", "b", String(i));
    sim.runUntilIdle();

    const unique = new Set(got);
    // Each copy is dropped independently, so a message is lost with p = 0.2
    // (or 0.2² when duplicated): about 79% arrive at least once.
    expect(unique.size / n).toBeGreaterThan(0.76);
    expect(unique.size / n).toBeLessThan(0.82);
    expect(got.length).toBeGreaterThan(unique.size);
    const inOrder = got.every((x, i) => i === 0 || x >= (got[i - 1] as number));
    expect(inOrder).toBe(false);
  });

  it("replays the exact same trace for the same seed", () => {
    const trace = (seed: number) => {
      const sim = new Simulation(seed);
      const net = new Network(sim, { latency: [1, 50], dropRate: 0.3, duplicateRate: 0.2 });
      const events: string[] = [];
      net.onTrace = (e) => events.push(`${e.time} ${e.kind} ${e.from}>${e.to}`);
      net.onDatagram("b", () => {});
      for (let i = 0; i < 50; i++) net.sendDatagram("a", "b", "x");
      sim.runUntilIdle();
      return events;
    };
    expect(trace(1)).toEqual(trace(1));
    expect(trace(1)).not.toEqual(trace(2));
  });
});
