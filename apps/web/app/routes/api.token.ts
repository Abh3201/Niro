import { BOARD_ID } from "@niro/sync";
import { issueToken, roleOfKey, shareKey } from "@niro/sync/auth";
import { getSecret } from "~/sharing.server";
import type { Route } from "./+types/api.token";

/** A board id and a key fit in far less; anything bigger isn't from our client. */
const MAX_BODY_BYTES = 1024;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Trades a share link's key for a 60-second token to open the realtime
 * WebSocket with: `POST {boardId, key}` returns `{token, role, viewKey?}`.
 * Editors also get the view key, so they can share a view-only link.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  const length = Number(request.headers.get("content-length"));
  if (!length) return json({ error: "Send a Content-Length." }, 411);
  if (length > MAX_BODY_BYTES) return json({ error: "Too large." }, 413);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send JSON." }, 400);
  }
  const { boardId, key } = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (typeof boardId !== "string" || !BOARD_ID.test(boardId) || typeof key !== "string") {
    return json({ error: "Send a boardId and a key." }, 400);
  }

  const secret = getSecret();
  const role = roleOfKey(secret, boardId, key);
  if (!role) return json({ error: "This link doesn't give access to the board." }, 403);
  return json({
    token: issueToken(secret, boardId, role),
    role,
    ...(role === "edit" && { viewKey: shareKey(secret, boardId, "view") }),
  });
}
