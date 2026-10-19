import { createEngine, type Engine } from "@niro/engine";
import type { SyncStatus } from "@niro/sync";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentKey } from "./access";
import { type OpenBoard, openBoard } from "./open-board";
import { PresenceBar } from "./PresenceBar";
import { SelectionPanel } from "./SelectionPanel";
import { Toolbar } from "./Toolbar";
import { useEngineState } from "./useEngineState";
import { ZoomControls } from "./ZoomControls";

interface Session {
  readonly engine: Engine;
  readonly board: OpenBoard;
}

/**
 * Hosts the canvas engine. React renders only the container and the controls
 * around it; the engine creates and draws its own canvases outside React's
 * render cycle, and the document never enters React state.
 */
export function Board({ boardId, realtimeUrl }: { boardId: string; realtimeUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    openBoard({ boardId, key: currentKey(boardId), realtimeUrl })
      .then((board) => {
        if (cancelled) {
          board.destroy();
          return;
        }
        const engine = createEngine(container, {
          doc: board.store,
          onPointerMove: board.presence.pointerMoved,
        });
        const detach = board.presence.attach(engine);
        setSession({ engine, board });
        cleanup = () => {
          detach();
          engine.destroy();
          board.destroy();
        };
      })
      .catch((error: unknown) => {
        console.error("Could not open the board", error);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      cleanup?.();
      setSession(null);
    };
  }, [boardId, realtimeUrl]);

  return (
    <>
      <div
        ref={containerRef}
        className="board"
        data-testid="board"
        data-ready={session ? "true" : "false"}
      />
      {failed && (
        <p className="panel notice" role="alert">
          This board could not be opened. Reload the page to try again.
        </p>
      )}
      {session && (
        <>
          <Toolbar engine={session.engine} />
          <SelectionPanel engine={session.engine} />
          <ZoomControls engine={session.engine} />
          <PresenceBar boardId={boardId} board={session.board} />
          <BoardStatus engine={session.engine} board={session.board} />
        </>
      )}
    </>
  );
}

/** Announces counts to screen readers and explains when the board can't be edited or saved. */
function BoardStatus({ engine, board }: { engine: Engine; board: OpenBoard }) {
  const shapes = useEngineState(engine, (s) => s.shapeCount, 0);
  const selected = useEngineState(engine, (s) => s.selection.length, 0);
  const readOnly = useEngineState(engine, (s) => s.readOnly, false);
  const status = useSyncExternalStore<SyncStatus>(
    board.status.subscribe,
    board.status.get,
    () => "connecting",
  );
  const refusal = useSyncExternalStore(board.refusal.subscribe, board.refusal.get, () => null);

  let notice: string | null = null;
  if (status === "denied") {
    notice = "This link doesn't give access to this board. Ask whoever shared it for a new link.";
  } else if (refusal !== null && board.role === "edit") {
    notice = "This board has reached its size limit, so it can't be edited any more.";
  } else if (readOnly && board.role === "edit") {
    notice = "This board was saved by a newer version of Niro, so it is read-only here.";
  } else if (!board.saved) {
    notice = "This browser isn't saving boards, so changes may be lost when you close the tab.";
  }

  return (
    <>
      <p className="visually-hidden" role="status" data-testid="board-status">
        {`${shapes} ${shapes === 1 ? "shape" : "shapes"}, ${selected} selected`}
      </p>
      {notice && (
        <p className="panel notice" role="alert">
          {notice}
        </p>
      )}
    </>
  );
}
