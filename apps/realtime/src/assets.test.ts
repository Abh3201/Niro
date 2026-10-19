import { createHash } from "node:crypto";
import { issueToken } from "@niro/sync/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAssets, sniffImageType } from "./assets";
import type { RealtimeServerOptions } from "./server";
import { BOARD, Harness, SECRET } from "./testing";

const h = new Harness();

beforeEach(async () => {
  await h.start();
});

afterEach(async () => {
  await h.stop();
});

async function restart(options: Partial<RealtimeServerOptions>) {
  await h.server.close();
  await h.start(options);
}

/** A PNG's signature and some bytes: enough for the server, which checks only the start. */
const png = (fill = 1, size = 64) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const auth = (role: "edit" | "view", board = BOARD) => ({
  authorization: `Bearer ${issueToken(SECRET, board, role)}`,
});
const upload = (data: Uint8Array, headers: Record<string, string>, type = "image/png") =>
  fetch(`http://${h.base}/assets/${BOARD}`, {
    method: "POST",
    headers: { "content-type": type, ...headers },
    body: data,
  });

describe("images", () => {
  it("stores an upload under its hash and serves it to anyone with a token for the board", async () => {
    const data = png();
    const res = await upload(data, auth("edit"));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: sha(data) });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const got = await fetch(`http://${h.base}/assets/${BOARD}/${sha(data)}`, {
      headers: auth("view"),
    });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(data);

    // The same file again is no new image.
    expect((await upload(data, auth("edit"))).status).toBe(200);
  });

  it("needs a token for the board, and an edit token to upload", async () => {
    const data = png();
    expect((await upload(data, {})).status).toBe(401);
    expect((await upload(data, auth("edit", "board-other1"))).status).toBe(401);
    expect((await upload(data, auth("view"))).status).toBe(403);
    await upload(data, auth("edit"));
    const url = `http://${h.base}/assets/${BOARD}/${sha(data)}`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: auth("view", "board-other1") })).status).toBe(401);
  });

  it("answers CORS preflights", async () => {
    const res = await fetch(`http://${h.base}/assets/${BOARD}`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("refuses files that aren't the image type they claim, and SVG", async () => {
    expect((await upload(png(), auth("edit"), "image/jpeg")).status).toBe(415);
    expect(
      (await upload(new TextEncoder().encode("<svg/>"), auth("edit"), "image/svg+xml")).status,
    ).toBe(415);
    expect((await upload(new Uint8Array(64), auth("edit"))).status).toBe(415);
  });

  it("refuses images over the size limit, and past the board's total", async () => {
    await restart({ limits: { imageBytes: 1000, boardImageBytes: 1500 } });
    expect((await upload(png(1, 1001), auth("edit"))).status).toBe(413);
    expect((await upload(png(1, 1000), auth("edit"))).status).toBe(201);
    expect((await upload(png(2, 600), auth("edit"))).status).toBe(413);
    expect((await upload(png(3, 500), auth("edit"))).status).toBe(201);
  });

  it("returns 404 for an image that isn't there", async () => {
    const res = await fetch(`http://${h.base}/assets/${BOARD}/${"0".repeat(64)}`, {
      headers: auth("view"),
    });
    expect(res.status).toBe(404);
  });
});

describe("sniffImageType", () => {
  it("knows each accepted type by its first bytes", () => {
    expect(sniffImageType(png())).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("<svg"))).toBeNull();
  });
});

describe("MemoryAssets", () => {
  it("keeps boards' images apart", async () => {
    const assets = new MemoryAssets();
    const asset = { type: "image/png" as const, data: png() };
    await assets.put("a", "x", asset, 1e6);
    expect(await assets.get("a", "x")).toEqual(asset);
    expect(await assets.get("b", "x")).toBeNull();
  });
});
