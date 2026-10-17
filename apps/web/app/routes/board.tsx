import { BOARD_ID } from "@niro/sync";
import { data } from "react-router";
import { Board } from "~/board/Board";
import { realtimeUrl } from "~/sharing.server";
import type { Route } from "./+types/board";

export function loader({ params, request }: Route.LoaderArgs) {
  // Board ids are nanoids; anything else is a mistyped link.
  if (!BOARD_ID.test(params.boardId)) throw data(null, { status: 404 });
  return { boardId: params.boardId, realtimeUrl: realtimeUrl(request) };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Niro" },
    { name: "description", content: "An open source, self-hostable whiteboard." },
  ];
}

export default function BoardRoute({ loaderData }: Route.ComponentProps) {
  const { boardId, realtimeUrl } = loaderData;
  // A new key remounts the board, so navigating between boards never mixes documents.
  return <Board key={boardId} boardId={boardId} realtimeUrl={realtimeUrl} />;
}
