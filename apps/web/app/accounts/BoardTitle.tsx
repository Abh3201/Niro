import { useState } from "react";
import { MAX_TITLE } from "./limits";

/** Sends one of the board page's account requests (see routes/api.board.ts). */
async function boardRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/board", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof answer.error === "string" ? answer.error : "Failed.");
  return answer;
}

/** Makes a board nobody owns yours. Resolves false if that didn't work. */
export async function claimBoard(boardId: string): Promise<boolean> {
  try {
    await boardRequest({ boardId, intent: "claim" });
    return true;
  } catch {
    return false;
  }
}

/** The board's name; its owner can click it to rename the board. */
export function BoardTitle({
  boardId,
  title,
  owned,
}: {
  boardId: string;
  title: string;
  owned: boolean;
}) {
  const [shown, setShown] = useState(title);
  const [editing, setEditing] = useState(false);

  if (!owned) {
    return (
      <span className="board-title" data-testid="board-title">
        {shown}
      </span>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        className="board-title"
        title="Rename this board"
        data-testid="board-title"
        onClick={() => setEditing(true)}
      >
        {shown}
      </button>
    );
  }
  const finish = async (value: string) => {
    setEditing(false);
    const next = value.trim();
    if (!next || next === shown) return;
    const before = shown;
    setShown(next);
    try {
      const answer = await boardRequest({ boardId, intent: "rename", title: next });
      if (typeof answer.title === "string") setShown(answer.title);
      document.title = `${typeof answer.title === "string" ? answer.title : next} · Niro`;
    } catch {
      setShown(before);
    }
  };
  return (
    <input
      className="board-title-input"
      aria-label="Board name"
      defaultValue={shown}
      maxLength={MAX_TITLE}
      // biome-ignore lint/a11y/noAutofocus: opened by a click on the name, to type a new one.
      autoFocus
      data-testid="board-title-input"
      onFocus={(event) => event.target.select()}
      onBlur={(event) => void finish(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = shown;
          event.currentTarget.blur();
        }
        // Keys typed here are the name's, not the board's shortcuts.
        event.stopPropagation();
      }}
    />
  );
}
