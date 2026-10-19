import { data } from "react-router";
import { Board } from "~/board/Board";
import type { Route } from "./+types/board";

/** Board ids are nanoids; anything else is a mistyped link. */
const BOARD_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function loader({ params }: Route.LoaderArgs) {
  if (!BOARD_ID.test(params.boardId)) throw data(null, { status: 404 });
  return { boardId: params.boardId };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Niro" },
    { name: "description", content: "An open source, self-hostable whiteboard." },
  ];
}

export default function BoardRoute({ loaderData }: Route.ComponentProps) {
  // A new key remounts the board, so navigating between boards never mixes documents.
  return <Board key={loaderData.boardId} boardId={loaderData.boardId} />;
}
