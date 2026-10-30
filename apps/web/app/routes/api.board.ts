import { BOARD_ID } from "@niro/sync";
import { getUser } from "~/accounts/auth.server";
import { claimBoard, cleanTitle, renameBoard } from "~/accounts/boards.server";
import { accountsEnabled } from "~/accounts/db.server";
import type { Route } from "./+types/api.board";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * What the board page does with a board's account side:
 * `POST {boardId, intent: "rename", title}` (its owner) and
 * `POST {boardId, intent: "claim"}` (an editor of a board nobody owns).
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!accountsEnabled()) return json({ error: "Accounts aren't set up." }, 404);
  const user = await getUser(request);
  if (!user) return json({ error: "Sign in first." }, 401);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return json({ error: "Send JSON." }, 400);
  }
  const { boardId, intent } = body;
  if (typeof boardId !== "string" || !BOARD_ID.test(boardId)) {
    return json({ error: "Send a boardId." }, 400);
  }
  if (intent === "rename") {
    const title = cleanTitle(body.title);
    if (!title) return json({ error: "Give it a name." }, 400);
    if (!(await renameBoard(user.id, boardId, title))) {
      return json({ error: "Only the board's owner can rename it." }, 403);
    }
    return json({ title });
  }
  if (intent === "claim") {
    if (!(await claimBoard(user.id, boardId))) {
      return json({ error: "Someone owns this board already, or you can't edit it." }, 409);
    }
    return json({ owned: true });
  }
  return json({ error: "Unknown intent." }, 400);
}
