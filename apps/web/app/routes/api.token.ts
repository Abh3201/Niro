import { BOARD_ID } from "@niro/sync";
import { issueToken, roleOfKey, shareKey } from "@niro/sync/auth";
import { getUser } from "~/accounts/auth.server";
import { getBoardInfo, memberRole, recordVisit } from "~/accounts/boards.server";
import { accountsEnabled } from "~/accounts/db.server";
import { getSecret } from "~/sharing.server";
import type { Route } from "./+types/api.token";

/** A board id and a key fit in far less; anything bigger isn't from our client. */
const MAX_BODY_BYTES = 1024;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Trades access to a board for a 60-second token to open the realtime
 * WebSocket with: `POST {boardId, key?}` returns `{token, role, key, viewKey?}`.
 *
 * Access is the share link's key, or, for someone signed in, the board
 * being on their list (they own it or opened it with a link before). The
 * answer carries the key for that access, so the page can put it back in
 * the address bar and the Share panel can show it; editors also get the
 * view key. Opening a board with a key while signed in puts it on your
 * list. A deleted board gives no token, whatever the key.
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
  if (typeof boardId !== "string" || !BOARD_ID.test(boardId)) {
    return json({ error: "Send a boardId." }, 400);
  }
  if (key !== undefined && key !== null && typeof key !== "string") {
    return json({ error: "The key must be a string." }, 400);
  }

  const secret = getSecret();
  const keyRole = typeof key === "string" ? roleOfKey(secret, boardId, key) : null;
  let role = keyRole;
  if (accountsEnabled()) {
    try {
      const [info, user] = await Promise.all([getBoardInfo(boardId), getUser(request)]);
      if (info?.deleted) return json({ error: "This board was deleted." }, 410);
      if (user) {
        const listed = await memberRole(user.id, boardId);
        if (listed === "edit" || !role) role = listed ?? role;
        if (role) await recordVisit(user.id, boardId, role);
      }
    } catch (error) {
      // Links don't need the accounts database: if it's down, the key alone decides.
      console.error("accounts database unavailable; checking the key alone", error);
    }
  }
  if (!role) return json({ error: "This link doesn't give access to the board." }, 403);
  return json({
    token: issueToken(secret, boardId, role),
    role,
    key: shareKey(secret, boardId, role),
    ...(role === "edit" && { viewKey: shareKey(secret, boardId, "view") }),
  });
}
