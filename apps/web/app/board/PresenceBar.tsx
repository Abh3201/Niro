import type { Engine } from "@niro/engine";
import type { SyncStatus } from "@niro/sync";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { shareLink } from "./access";
import type { OpenBoard } from "./open-board";
import { MAX_NAME_LENGTH, type Person } from "./presence";
import { useEngineState } from "./useEngineState";

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
export function PresenceBar({
  boardId,
  board,
  engine,
}: {
  boardId: string;
  board: OpenBoard;
  engine: Engine;
}) {
  const following = useEngineState(engine, (s) => s.following, null);
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
  const presenting = useEngineState(engine, (s) => s.presenting !== null, false);
  // Someone is stepping through the frames: offer to come along (never forced).
  const presenter = presenting || following !== null ? undefined : people.find((p) => p.presenting);
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
            <li key={person.id} className="avatar-item">
              {person.self ? (
                <span
                  className="avatar"
                  style={{ background: person.color }}
                  title={`${person.name} (you)`}
                  data-testid="avatar-self"
                >
                  <span aria-hidden="true">{initials(person.name)}</span>
                  <span className="visually-hidden">{`${person.name} (you)`}</span>
                </span>
              ) : (
                // Click someone's avatar to see what they see.
                <button
                  type="button"
                  className="avatar"
                  style={{ background: person.color }}
                  title={
                    following === person.id
                      ? `Stop following ${person.name}`
                      : `Follow ${person.name}`
                  }
                  aria-pressed={following === person.id}
                  data-testid="avatar"
                  data-following={following === person.id}
                  onClick={() => engine.follow(following === person.id ? null : person.id)}
                >
                  <span aria-hidden="true">{initials(person.name)}</span>
                  <span className="visually-hidden">
                    {following === person.id
                      ? `Stop following ${person.name}`
                      : `Follow ${person.name}`}
                  </span>
                </button>
              )}
            </li>
          ))}
          {hidden > 0 && (
            <li className="avatar-item">
              <span className="avatar more">+{hidden}</span>
            </li>
          )}
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
      {following !== null && (
        <div className="panel following" role="status" data-testid="following">
          <span>Following {people.find((p) => p.id === following)?.name ?? "someone"}</span>
          <button type="button" onClick={() => engine.follow(null)} data-testid="stop-following">
            Stop
          </button>
        </div>
      )}
      {presenter && (
        <div className="panel following" role="status" data-testid="presenter-banner">
          <span>{presenter.name} is presenting</span>
          <button
            type="button"
            onClick={() => engine.follow(presenter.id)}
            data-testid="follow-presenter"
          >
            Follow
          </button>
        </div>
      )}
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
