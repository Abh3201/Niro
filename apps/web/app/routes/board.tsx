import { BOARD_ID } from "@niro/sync";
import { data } from "react-router";
import { getUser } from "~/accounts/auth.server";
import { DEFAULT_TITLE, getBoardInfo } from "~/accounts/boards.server";
import { accountsEnabled } from "~/accounts/db.server";
import type { BoardAccount } from "~/accounts/types";
import { Board } from "~/board/Board";
import { realtimeUrl } from "~/sharing.server";
import type { Route } from "./+types/board";

export async function loader({ params, request }: Route.LoaderArgs) {
  // Board ids are nanoids; anything else is a mistyped link.
  if (!BOARD_ID.test(params.boardId)) throw data(null, { status: 404 });
  let account: BoardAccount | null = null;
  if (accountsEnabled()) {
    // The board doesn't need the accounts database: if it's down, open it
    // as for someone signed out (its link still works).
    const [user, info] = await Promise.all([getUser(request), getBoardInfo(params.boardId)]).catch(
      (error: unknown) => {
        console.error("accounts database unavailable; opening the board without it", error);
        return [null, null] as const;
      },
    );
    if (info?.deleted) throw data(null, { status: 410, statusText: "This board was deleted." });
    account = {
      viewer: user && { name: user.name, email: user.email, image: user.image },
      title: info?.title ?? DEFAULT_TITLE,
      owned: user !== null && info?.ownerId === user.id,
      ownerless: !info?.ownerId,
    };
  }
  return { boardId: params.boardId, realtimeUrl: realtimeUrl(request), account };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.account?.title;
  return [
    { title: title ? `${title} · Niro` : "Niro" },
    { name: "description", content: "An open source, self-hostable whiteboard." },
  ];
}

export default function BoardRoute({ loaderData }: Route.ComponentProps) {
  const { boardId, realtimeUrl, account } = loaderData;
  // A new key remounts the board, so navigating between boards never mixes documents.
  return <Board key={boardId} boardId={boardId} realtimeUrl={realtimeUrl} account={account} />;
}
