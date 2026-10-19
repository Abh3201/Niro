import type { SyncStatus } from "@niro/sync";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { shareLink } from "./access";
import type { OpenBoard } from "./open-board";
import { MAX_NAME_LENGTH, type Person } from "./presence";

const STATUS_LABEL: Record<SyncStatus, string> = {
  online: "Live",
  connecting: "Connecting…",
  offline: "Offline",
  denied: "No access",
};

/** Avatars shown before the rest are summed up as "+N". */
const MAX_AVATARS = 5;
const NOBODY: readonly Person[] = [];

/** Top right: connection status, who's here, and sharing. */
export function PresenceBar({ boardId, board }: { boardId: string; board: OpenBoard }) {
  const status = useSyncExternalStore<SyncStatus>(
    board.status.subscribe,
    board.status.get,
    () => "connecting",
  );
  const people = useSyncExternalStore(
    board.presence.subscribe,
    board.presence.getPeople,
    () => NOBODY,
  );
  const [sharing, setSharing] = useState(false);
  const shown = people.slice(0, MAX_AVATARS);
  const hidden = people.length - shown.length;

  return (
    <div className="presence">
      <div className="panel presence-bar">
        <span className="status" data-status={status} data-testid="sync-status" role="status">
          {STATUS_LABEL[status]}
        </span>
        {board.role === "view" && status !== "denied" && (
          <span className="badge" data-testid="view-only">
            View only
          </span>
        )}
        <ul className="avatars" aria-label="People on this board">
          {shown.map((person) => (
            <li
              key={person.id}
              className="avatar"
              style={{ background: person.color }}
              title={person.self ? `${person.name} (you)` : person.name}
              data-testid={person.self ? "avatar-self" : "avatar"}
            >
              <span aria-hidden="true">{initials(person.name)}</span>
              <span className="visually-hidden">
                {person.self ? `${person.name} (you)` : person.name}
              </span>
            </li>
          ))}
          {hidden > 0 && <li className="avatar more">+{hidden}</li>}
        </ul>
        <button
          type="button"
          className="share-button"
          aria-expanded={sharing}
          data-testid="share-button"
          onClick={() => setSharing((open) => !open)}
        >
          Share
        </button>
      </div>
      {sharing && <SharePanel boardId={boardId} board={board} onClose={() => setSharing(false)} />}
    </div>
  );
}

function SharePanel({
  boardId,
  board,
  onClose,
}: {
  boardId: string;
  board: OpenBoard;
  onClose: () => void;
}) {
  const editorsViewKey = useSyncExternalStore(
    board.viewKey.subscribe,
    board.viewKey.get,
    () => null,
  );
  const editKey = board.role === "edit" ? board.key : null;
  // Viewers can pass on their own link; editors get the view key from the server.
  const viewKey = board.role === "edit" ? editorsViewKey : board.key;
  const panel = useRef<HTMLDivElement>(null);
  const nameId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!panel.current?.parentElement?.contains(event.target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  return (
    <div className="panel share-panel" ref={panel} role="dialog" aria-label="Share this board">
      <label htmlFor={nameId}>Your name</label>
      <input
        id={nameId}
        defaultValue={board.presence.identity().name}
        maxLength={MAX_NAME_LENGTH}
        data-testid="your-name"
        onChange={(event) => board.presence.rename(event.target.value)}
      />
      {editKey && (
        <LinkField
          label="Anyone with this link can edit"
          link={shareLink(boardId, editKey)}
          testId="share-edit-link"
        />
      )}
      {viewKey ? (
        <LinkField
          label="Anyone with this link can view"
          link={shareLink(boardId, viewKey)}
          testId="share-view-link"
        />
      ) : (
        board.role === "edit" && (
          <p className="hint">The view-only link appears once you're online.</p>
        )
      )}
      {board.role === "view" && <p className="hint">To edit, ask an editor for their link.</p>}
    </div>
  );
}

function LinkField({ label, link, testId }: { label: string; link: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the field is selectable, so it can be copied by hand.
    }
  };
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="link-field">
        <input
          id={id}
          readOnly
          value={link}
          data-testid={testId}
          onFocus={(event) => event.target.select()}
        />
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </>
  );
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters
    .map((word) => [...(word ?? "")][0] ?? "")
    .join("")
    .toUpperCase();
}
