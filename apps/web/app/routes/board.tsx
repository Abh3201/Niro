import { BoardCanvas } from "~/components/BoardCanvas";
import type { Route } from "./+types/board";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Niro" },
    { name: "description", content: "An open source, self-hostable whiteboard." },
  ];
}

export default function Board() {
  return <BoardCanvas />;
}
