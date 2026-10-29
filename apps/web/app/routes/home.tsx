import { shareKey } from "@niro/sync/auth";
import { nanoid } from "nanoid";
import { redirect } from "react-router";
import { getUser } from "~/accounts/auth.server";
import { getSecret } from "~/sharing.server";
import type { Route } from "./+types/home";

/**
 * Signed in, the home page is your list of boards. Otherwise every visit
 * starts a new board, and makes you its editor: the edit key goes in the
 * link's fragment (`#k=`), which browsers never send to a server, so it
 * stays out of access logs and Referer headers.
 */
export async function loader({ request }: Route.LoaderArgs) {
  if (await getUser(request)) return redirect("/boards");
  const boardId = nanoid();
  return redirect(`/b/${boardId}#k=${shareKey(getSecret(), boardId, "edit")}`);
}
