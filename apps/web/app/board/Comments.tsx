import { type CommentThread, MAX_COMMENT_LENGTH } from "@niro/doc/comments";
import { centerOn, type Engine, type EngineState, type Point, worldToScreen } from "@niro/engine";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CommentIcon } from "./icons";
import { MenuButton } from "./MenuButton";
import type { OpenBoard } from "./open-board";
import { loadIdentity, loadUserId } from "./presence";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const POPOVER_WIDTH = 300;
const PIN_SIZE = 28;

/** Where a thread's pin is on the board: on its shape if that is still there, else where it was dropped. */
function pinPoint(engine: Engine, thread: CommentThread): Point {
  const box = thread.shape ? engine.boundsOf(thread.shape as never) : null;
  return box ? { x: box.minX + thread.ox, y: box.minY + thread.oy } : { x: thread.x, y: thread.y };
}

/** How many messages of each thread this browser has read, so a thread with something new shows it. */
function useSeen(boardId: string) {
  const key = `niro:comments-seen:${boardId}`;
  const [seen, setSeen] = useState<Record<string, number>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      return typeof stored === "object" && stored !== null
        ? (stored as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  });
  const markSeen = useCallback(
    (thread: CommentThread) => {
      setSeen((current) => {
        if (current[thread.id] === thread.messages.length) return current;
        const next = { ...current, [thread.id]: thread.messages.length };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Not remembered; threads show as new again next visit.
        }
        return next;
      });
    },
    [key],
  );
  return { seen, markSeen };
}

interface Draft {
  readonly x: number;
  readonly y: number;
  readonly shape?: { readonly id: string; readonly ox: number; readonly oy: number } | undefined;
}

/**
 * Comment pins over the board, the popover for one thread (or a new one),
 * and the list of threads. The comments live in the document next to the
 * shapes (see decision 0012) but not in the engine: the pins are ordinary
 * page elements placed from the engine's camera.
 */
export function Comments({
  engine,
  board,
  boardId,
  placing,
  onPlaced,
  listOpen,
  onCloseList,
}: {
  engine: Engine;
  board: OpenBoard;
  boardId: string;
  /** True while the next click on the board drops a pin. */
  placing: boolean;
  /** Called once a pin is dropped, or placing is cancelled. */
  onPlaced: () => void;
  listOpen: boolean;
  onCloseList: () => void;
}) {
  const threads = useSyncExternalStore(
    board.comments.subscribe,
    board.comments.threads,
    () => [] as readonly CommentThread[],
  );
  // Any change on the board moves pins that follow shapes, so read the whole state.
  const state = useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
  const readOnly = state.readOnly || board.role === "view";
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const { seen, markSeen } = useSeen(boardId);
  const userId = useRef(loadUserId()).current;

  // While placing, the next press on the board drops a pin instead of reaching the engine.
  useEffect(() => {
    if (!placing) return;
    const container = document.querySelector<HTMLElement>('[data-testid="board"]');
    if (!container) return;
    container.classList.add("board--placing");
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const box = container.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const world = engine.getState().camera;
      const at = { x: point.x / world.zoom + world.x, y: point.y / world.zoom + world.y };
      const id = engine.shapeAt(point);
      const bounds = id ? engine.boundsOf(id) : null;
      setOpenId(null);
      setDraft({
        x: at.x,
        y: at.y,
        ...(id && bounds ? { shape: { id, ox: at.x - bounds.minX, oy: at.y - bounds.minY } } : {}),
      });
      onPlaced();
    };
    container.addEventListener("pointerdown", onDown, true);
    return () => {
      container.classList.remove("board--placing");
      container.removeEventListener("pointerdown", onDown, true);
    };
  }, [placing, engine, onPlaced]);

  // Esc backs out of placing.
  useEffect(() => {
    if (!placing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onPlaced();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing, onPlaced]);

  const visible = threads.filter((t) => showResolved || !t.resolved || t.id === openId);
  const open = threads.find((t) => t.id === openId) ?? null;
  const goTo = (thread: CommentThread) => {
    const world = pinPoint(engine, thread);
    const { viewport, camera } = engine.getState();
    engine.setCamera(centerOn(world, viewport, camera.zoom));
    setDraft(null);
    setOpenId(thread.id);
  };

  return (
    <>
      <div className="comments-layer" data-testid="comments-layer">
        {visible.map((thread) => {
          const screen = worldToScreen(state.camera, pinPoint(engine, thread));
          if (
            screen.x < -PIN_SIZE ||
            screen.y < -PIN_SIZE ||
            screen.x > state.viewport.width + PIN_SIZE ||
            screen.y > state.viewport.height + PIN_SIZE
          )
            return null;
          const first = thread.messages[0];
          const last = thread.messages[thread.messages.length - 1];
          const unread = (seen[thread.id] ?? 0) < thread.messages.length && last?.userId !== userId;
          return (
            <button
              key={thread.id}
              type="button"
              className="comment-pin"
              data-resolved={thread.resolved}
              data-unread={unread}
              data-testid="comment-pin"
              style={{
                transform: `translate(${screen.x}px, ${screen.y - PIN_SIZE}px)`,
                background: first?.color,
              }}
              aria-label={`Comment by ${first?.name ?? "someone"}, ${thread.messages.length} ${
                thread.messages.length === 1 ? "message" : "messages"
              }${thread.resolved ? ", resolved" : ""}${unread ? ", new" : ""}`}
              onClick={() => {
                setDraft(null);
                setOpenId(thread.id === openId ? null : thread.id);
              }}
            >
              {thread.messages.length > 1 ? thread.messages.length : (first?.name[0] ?? "?")}
            </button>
          );
        })}
      </div>
      {draft && (
        <Popover
          at={worldToScreen(state.camera, { x: draft.x, y: draft.y })}
          width={state.viewport.width}
          onClose={() => setDraft(null)}
        >
          <ThreadForm
            label="Add a comment"
            submit="Comment"
            onSubmit={(text) => {
              const identity = loadIdentity();
              const id = board.comments.add(draft, { userId, ...identity, text });
              setDraft(null);
              if (id) setOpenId(id);
            }}
            onCancel={() => setDraft(null)}
          />
        </Popover>
      )}
      {open && (
        <ThreadPopover
          thread={open}
          engine={engine}
          board={board}
          userId={userId}
          readOnly={readOnly}
          state={state}
          onSeen={markSeen}
          onClose={() => setOpenId(null)}
        />
      )}
      {listOpen && (
        <aside className="panel comment-list" aria-label="Comments" data-testid="comment-list">
          <header>
            <h2>Comments</h2>
            <label>
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(event) => setShowResolved(event.target.checked)}
                data-testid="comments-show-resolved"
              />{" "}
              Show resolved
            </label>
            <button type="button" aria-label="Close the list of comments" onClick={onCloseList}>
              ×
            </button>
          </header>
          {threads.filter((t) => showResolved || !t.resolved).length === 0 && (
            <p className="comment-hint">
              {readOnly
                ? "No comments yet."
                : "No comments yet. Press C, then click where it goes."}
            </p>
          )}
          <ul>
            {threads
              .filter((t) => showResolved || !t.resolved)
              .map((thread) => {
                const first = thread.messages[0];
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      data-testid="comment-list-item"
                      onClick={() => goTo(thread)}
                    >
                      <span className="comment-dot" style={{ background: first?.color }} />
                      <span className="comment-snippet">
                        <strong>{first?.name}</strong> {first?.text}
                      </span>
                      <span className="comment-meta">
                        {thread.resolved ? "Resolved · " : ""}
                        {thread.messages.length === 1
                          ? when.format(thread.createdAt)
                          : `${thread.messages.length} messages`}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </aside>
      )}
    </>
  );
}

/** Keeps its content next to a point on screen, on whichever side has room. */
function Popover({
  at,
  width,
  onClose,
  children,
}: {
  at: Point;
  width: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const left =
    at.x + 16 + POPOVER_WIDTH > width ? Math.max(8, at.x - 16 - POPOVER_WIDTH) : at.x + 16;
  return (
    <section
      role="dialog"
      aria-label="Comment"
      className="panel comment-popover"
      style={{ left, top: Math.max(8, at.y - PIN_SIZE) }}
      data-testid="comment-popover"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </section>
  );
}

function ThreadPopover({
  thread,
  engine,
  board,
  userId,
  readOnly,
  state,
  onSeen,
  onClose,
}: {
  thread: CommentThread;
  engine: Engine;
  board: OpenBoard;
  userId: string;
  readOnly: boolean;
  state: EngineState;
  onSeen: (thread: CommentThread) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => onSeen(thread), [thread, onSeen]);
  return (
    <Popover
      at={worldToScreen(state.camera, pinPoint(engine, thread))}
      width={state.viewport.width}
      onClose={onClose}
    >
      <header>
        <strong>{thread.resolved ? "Resolved comment" : "Comment"}</strong>
        <span className="comment-actions">
          {!readOnly && (
            <button
              type="button"
              data-testid="comment-resolve"
              onClick={() => {
                board.comments.setResolved(thread.id, !thread.resolved);
                // A resolved thread leaves the board; closing it now shows that.
                if (!thread.resolved) onClose();
              }}
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
          )}
          {!readOnly &&
            (confirming ? (
              <button
                type="button"
                data-testid="comment-delete-confirm"
                onClick={() => {
                  board.comments.remove(thread.id);
                  onClose();
                }}
              >
                Delete for everyone?
              </button>
            ) : (
              <button
                type="button"
                data-testid="comment-delete"
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            ))}
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </span>
      </header>
      <ol className="comment-messages">
        {thread.messages.map((message) => (
          <li key={message.id} data-testid="comment-message">
            <span className="comment-dot" style={{ background: message.color }} />
            <div>
              <div className="comment-byline">
                <strong>
                  {message.userId === userId ? `${message.name} (you)` : message.name}
                </strong>{" "}
                <time dateTime={new Date(message.at).toISOString()}>{when.format(message.at)}</time>
              </div>
              <p>{message.text}</p>
            </div>
          </li>
        ))}
      </ol>
      {!readOnly && (
        <ThreadForm
          label="Reply"
          submit="Reply"
          onSubmit={(text) => {
            const identity = loadIdentity();
            board.comments.reply(thread.id, { userId, ...identity, text });
          }}
        />
      )}
    </Popover>
  );
}

/** A text box with a button: Ctrl/⌘ + Enter also sends. */
function ThreadForm({
  label,
  submit,
  onSubmit,
  onCancel,
}: {
  label: string;
  submit: string;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const send = () => {
    if (text.trim() === "") return;
    onSubmit(text);
    setText("");
  };
  return (
    <form
      className="comment-form"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        ref={field}
        value={text}
        maxLength={MAX_COMMENT_LENGTH}
        rows={2}
        placeholder={label}
        aria-label={label}
        data-testid="comment-text"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <span className="comment-actions">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={text.trim() === ""} data-testid="comment-send">
          {submit}
        </button>
      </span>
    </form>
  );
}

/** Starts placing a comment when C is pressed anywhere but in a text field. */
export function useCommentKey(onPress: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, dialog"))
      )
        return;
      event.preventDefault();
      onPress();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onPress]);
}

/** In the tool bar: one button whose menu places a comment or opens the list of them. */
export function CommentMenu({
  count,
  placing,
  canComment,
  listOpen,
  onPlace,
  onList,
}: {
  /** Threads not resolved. */
  count: number;
  placing: boolean;
  canComment: boolean;
  listOpen: boolean;
  onPlace: () => void;
  onList: () => void;
}) {
  return (
    <MenuButton
      label="Comments"
      title="Comments (C adds one)"
      icon={<CommentIcon />}
      testId="comments-menu"
      active={placing || listOpen}
      badge={count}
      side="right"
    >
      {(close) => (
        <>
          <button
            type="button"
            aria-pressed={placing}
            disabled={!canComment}
            title={
              canComment
                ? "Add a comment: click where it goes (C)"
                : "Only people who can edit can add comments"
            }
            data-testid="comment-add"
            onClick={() => {
              onPlace();
              close();
            }}
          >
            Add comment<kbd>C</kbd>
          </button>
          <button
            type="button"
            aria-pressed={listOpen}
            title="List the comments"
            data-testid="comments-open"
            onClick={() => {
              onList();
              close();
            }}
          >
            {`All comments${count > 0 ? ` (${count})` : ""}`}
          </button>
        </>
      )}
    </MenuButton>
  );
}
