/**
 * Share links and access tokens. Server-side only (it needs the secret).
 *
 * There are no accounts. Whoever has a board's link has access. The link
 * carries a key: an HMAC of the board id and a role under the server's
 * secret. So the server can check a key without storing anything, and
 * nobody can make a key without the secret.
 *
 * The browser trades the key at the web app for a token that lasts 60
 * seconds, and opens the WebSocket with that. The long-lived key then never
 * appears in a WebSocket URL, where proxies and servers tend to log it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "./room";

export interface Grant {
  readonly boardId: string;
  readonly role: Role;
  /** Expiry, in milliseconds since the epoch. */
  readonly expires: number;
}

export const TOKEN_TTL_MS = 60_000;
const MIN_SECRET_LENGTH = 32;
const DEV_SECRET = "niro-development-secret-never-use-in-production";
const ROLE_PREFIX = { edit: "e", view: "v" } as const satisfies Record<Role, string>;

const mac = (secret: string, message: string) =>
  createHmac("sha256", secret).update(message).digest("base64url");

/** Compares in constant time, so response timing doesn't reveal how much of a guess was right. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The secret both servers sign with, from `NIRO_SECRET`. In development a
 * fixed one is used when it's unset; in production it is required, because
 * a known secret lets anyone make an edit link to any board.
 */
export function readSecret(env: Readonly<Record<string, string | undefined>>): string {
  const secret = env.NIRO_SECRET;
  if (secret && secret.length >= MIN_SECRET_LENGTH) return secret;
  if (secret || env.NODE_ENV === "production") {
    throw new Error(
      `NIRO_SECRET must be at least ${MIN_SECRET_LENGTH} characters. Make one with: openssl rand -hex 32`,
    );
  }
  return DEV_SECRET;
}

/** The key in a share link: `e.` or `v.` and 22 characters (132 bits) of HMAC. */
export function shareKey(secret: string, boardId: string, role: Role): string {
  return `${ROLE_PREFIX[role]}.${mac(secret, `niro:key:${role}:${boardId}`).slice(0, 22)}`;
}

/** The role a key grants on a board, or null if it's not a valid key for it. */
export function roleOfKey(secret: string, boardId: string, key: string): Role | null {
  if (same(key, shareKey(secret, boardId, "edit"))) return "edit";
  if (same(key, shareKey(secret, boardId, "view"))) return "view";
  return null;
}

/** A short-lived token: base64url JSON, a dot, and its HMAC. */
export function issueToken(secret: string, boardId: string, role: Role, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ b: boardId, r: role, e: now + TOKEN_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${mac(secret, `niro:token:${payload}`)}`;
}

/** What a token grants, or null if it's forged, malformed or expired. */
export function verifyToken(secret: string, token: string, now = Date.now()): Grant | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!same(signature, mac(secret, `niro:token:${payload}`))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { b, r, e } = claims as Record<string, unknown>;
  if (typeof b !== "string" || (r !== "edit" && r !== "view") || typeof e !== "number") return null;
  if (now > e) return null;
  return { boardId: b, role: r, expires: e };
}
