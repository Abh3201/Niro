import { shareKey } from "@niro/sync/auth";
import { nanoid } from "nanoid";
import { redirect } from "react-router";
import { getSecret } from "~/sharing.server";

/**
 * Every visit to the home page starts a new board, and makes you its editor:
 * the edit key goes in the link's fragment (`#k=`), which browsers never
 * send to a server, so it stays out of access logs and Referer headers.
 */
export function loader() {
  const boardId = nanoid();
  return redirect(`/b/${boardId}#k=${shareKey(getSecret(), boardId, "edit")}`);
}
