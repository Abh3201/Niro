import { issueToken } from "@niro/sync/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BOARD, Harness, SECRET, until } from "./testing";
import { MemoryVersions, type VersionInfo, versionsToDrop } from "./versions";

const h = new Harness();

beforeEach(async () => {
  await h.start();
});

afterEach(async () => {
  await h.stop();
});

const auth = (role: "edit" | "view", board = BOARD) => ({
  authorization: `Bearer ${issueToken(SECRET, board, role)}`,
});
const info = (id: number, auto: boolean, bytes = 10): VersionInfo => ({
  id: String(id),
  createdAt: id,
  label: null,
  auto,
  bytes,
});

describe("versionsToDrop", () => {
  it("drops those saved by the server first, oldest first, and never the new one", () => {
    const all = [info(1, false), info(2, true), info(3, true), info(4, false), info(5, true)];
    expect(versionsToDrop(all, "5", { count: 3, bytes: 1000 })).toEqual(["2", "3"]);
    expect(versionsToDrop(all, "5", { count: 1, bytes: 1000 })).toEqual(["2", "3", "1", "4"]);
  });

  it("also keeps within the byte limit", () => {
    const all = [info(1, true, 40), info(2, true, 40), info(3, false, 40)];
    expect(versionsToDrop(all, "3", { count: 10, bytes: 90 })).toEqual(["1"]);
  });

  it("drops nothing when everything fits", () => {
    expect(versionsToDrop([info(1, true)], "1", { count: 5, bytes: 100 })).toEqual([]);
  });
});

describe("MemoryVersions", () => {
  it("lists newest first and returns the state it was given", async () => {
    const store = new MemoryVersions();
    const limits = { count: 5, bytes: 100 };
    await store.saveVersion("b", { label: "one", auto: false, state: new Uint8Array([1]) }, limits);
    const second = await store.saveVersion(
      "b",
      { label: null, auto: true, state: new Uint8Array([2, 2]) },
      limits,
    );
    expect((await store.listVersions("b")).map((v) => v.label)).toEqual([null, "one"]);
    expect(await store.loadVersion("b", second?.id ?? "")).toEqual(new Uint8Array([2, 2]));
    expect(await store.loadVersion("other", second?.id ?? "")).toBeNull();
  });

  it("refuses a state over the byte limit", async () => {
    const store = new MemoryVersions();
    const saved = await store.saveVersion(
      "b",
      { label: null, auto: false, state: new Uint8Array(11) },
      { count: 5, bytes: 10 },
    );
    expect(saved).toBeNull();
    expect(await store.listVersions("b")).toEqual([]);
  });
});

describe("version routes", () => {
  const save = (headers: Record<string, string>, label?: string, board = BOARD) =>
    fetch(`http://${h.base}/versions/${board}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(label === undefined ? {} : { label }),
    });

  it("saves the open board as it is, lists it, and serves its state", async () => {
    const tab = h.tab();
    await until(() => tab.client.status === "online");
    tab.doc.getMap("shapes").set("a", 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await save(auth("edit"), "  Before the workshop \n");
    expect(res.status).toBe(201);
    const saved = (await res.json()) as VersionInfo;
    expect(saved).toMatchObject({ label: "Before the workshop", auto: false });

    const list = await fetch(`http://${h.base}/versions/${BOARD}`, { headers: auth("view") });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { versions: VersionInfo[] }).versions.map((v) => v.id)).toEqual([
      saved.id,
    ]);

    const state = await fetch(`http://${h.base}/versions/${BOARD}/${saved.id}`, {
      headers: auth("view"),
    });
    expect(state.status).toBe(200);
    expect(state.headers.get("content-type")).toBe("application/octet-stream");
    const copy = new Y.Doc();
    Y.applyUpdate(copy, new Uint8Array(await state.arrayBuffer()));
    expect(copy.getMap("shapes").get("a")).toBe(1);
  });

  it("needs a token for the board, and an edit token to save", async () => {
    const tab = h.tab();
    await until(() => tab.client.status === "online");
    expect((await save({})).status).toBe(401);
    expect((await save(auth("edit", "another-board-1"))).status).toBe(401);
    expect((await save(auth("view"))).status).toBe(403);
    const list = await fetch(`http://${h.base}/versions/${BOARD}`);
    expect(list.status).toBe(401);
  });

  it("has nothing to save when nobody has the board open", async () => {
    expect((await save(auth("edit"))).status).toBe(409);
  });

  it("slows down saving by hand", async () => {
    const tab = h.tab();
    await until(() => tab.client.status === "online");
    expect((await save(auth("edit"), "one")).status).toBe(201);
    expect((await save(auth("edit"), "two")).status).toBe(429);
  });

  it("rejects ids that aren't digits and bad bodies", async () => {
    const tab = h.tab();
    await until(() => tab.client.status === "online");
    const bad = await fetch(`http://${h.base}/versions/${BOARD}/abc`, { headers: auth("edit") });
    expect(bad.status).toBe(404);
    const body = await fetch(`http://${h.base}/versions/${BOARD}`, {
      method: "POST",
      headers: { ...auth("edit"), "content-type": "application/json" },
      body: "{not json",
    });
    expect(body.status).toBe(400);
    const missing = await fetch(`http://${h.base}/versions/${BOARD}/99`, { headers: auth("edit") });
    expect(missing.status).toBe(404);
  });

  it("saves a version by itself when a board is first written", async () => {
    const tab = h.tab();
    await until(() => tab.client.status === "online");
    tab.doc.getMap("shapes").set("a", 1);
    // The room writes the board when the last person leaves.
    tab.close();
    let versions: VersionInfo[] = [];
    for (let i = 0; i < 200 && versions.length === 0; i++) {
      const res = await fetch(`http://${h.base}/versions/${BOARD}`, { headers: auth("view") });
      versions = ((await res.json()) as { versions: VersionInfo[] }).versions;
      if (versions.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(versions[0]).toMatchObject({ auto: true, label: null });
  });
});
