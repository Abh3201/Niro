import { describe, expect, it } from "vitest";
import { issueToken, readSecret, roleOfKey, shareKey, TOKEN_TTL_MS, verifyToken } from "./auth";

const SECRET = "test-secret-0123456789abcdef0123456789";
const BOARD = "board-123456";

describe("share keys", () => {
  it("grant the role they were made for, on their board only", () => {
    const edit = shareKey(SECRET, BOARD, "edit");
    const view = shareKey(SECRET, BOARD, "view");
    expect(edit).toMatch(/^e\.[A-Za-z0-9_-]{22}$/);
    expect(view).toMatch(/^v\.[A-Za-z0-9_-]{22}$/);
    expect(roleOfKey(SECRET, BOARD, edit)).toBe("edit");
    expect(roleOfKey(SECRET, BOARD, view)).toBe("view");
    expect(roleOfKey(SECRET, "other-board", edit)).toBeNull();
    expect(roleOfKey("another-secret-0123456789abcdef0123", BOARD, edit)).toBeNull();
    // Changing the prefix doesn't turn a view key into an edit key.
    expect(roleOfKey(SECRET, BOARD, `e${view.slice(1)}`)).toBeNull();
    expect(roleOfKey(SECRET, BOARD, "")).toBeNull();
  });
});

describe("tokens", () => {
  it("carry the board and role until they expire", () => {
    const token = issueToken(SECRET, BOARD, "view", 1000);
    expect(verifyToken(SECRET, token, 1000)).toEqual({
      boardId: BOARD,
      role: "view",
      expires: 1000 + TOKEN_TTL_MS,
    });
    expect(verifyToken(SECRET, token, 1000 + TOKEN_TTL_MS)).not.toBeNull();
    expect(verifyToken(SECRET, token, 1001 + TOKEN_TTL_MS)).toBeNull();
  });

  it("can't be forged or edited", () => {
    const token = issueToken(SECRET, BOARD, "view", 1000);
    const [payload, signature] = token.split(".") as [string, string];
    const promoted = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), r: "edit" }),
    ).toString("base64url");
    expect(verifyToken(SECRET, `${promoted}.${signature}`, 1000)).toBeNull();
    expect(verifyToken("another-secret-0123456789abcdef0123", token, 1000)).toBeNull();
    for (const bad of ["", ".", "a.b.c", payload, `${payload}.`, "not base64.!!"]) {
      expect(verifyToken(SECRET, bad, 1000)).toBeNull();
    }
    // A share key is not a token, even though both are HMACs under the same secret.
    expect(verifyToken(SECRET, shareKey(SECRET, BOARD, "edit"), 1000)).toBeNull();
  });
});

describe("readSecret", () => {
  it("requires a long secret in production and has a fallback in development", () => {
    expect(readSecret({ NIRO_SECRET: SECRET, NODE_ENV: "production" })).toBe(SECRET);
    expect(() => readSecret({ NODE_ENV: "production" })).toThrow(/NIRO_SECRET/);
    expect(() => readSecret({ NIRO_SECRET: "short" })).toThrow(/at least 32/);
    expect(readSecret({})).toMatch(/development/);
  });
});
