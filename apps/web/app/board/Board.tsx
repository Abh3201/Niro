import { createEngine, type Engine } from "@niro/engine";
import type { SyncStatus } from "@niro/sync";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentKey } from "./access";
import { firstImage, ImageError } from "./assets";
import { ExportControls } from "./ExportControls";
import { type OpenBoard, openBoard } from "./open-board";
import { PresenceBar } from "./PresenceBar";
import { loadUserId } from "./presence";
import { SelectionPanel } from "./SelectionPanel";
import { ShortcutsHelp, useHelpKey } from "./ShortcutsHelp";
import { Toolbar } from "./Toolbar";
import { engineScheme, getThemeChoice, useThemeChoice } from "./theme";
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  useHelpKey(openHelp);
  const theme = useThemeChoice();

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
          loadImage: board.assets.load,
          userId: loadUserId(),

          colorScheme: engineScheme(getThemeChoice()),
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

  const addImage = useCallback(
    async (file: File, at?: { x: number; y: number }) => {
      if (!session || session.engine.getState().readOnly) return;
      setImageNotice("Adding the image…");
      try {
        const image = await session.board.assets.upload(file);
        session.engine.insertImage(image.asset, image, at);
        setImageNotice(null);
      } catch (error) {
        if (!(error instanceof ImageError)) console.error("Could not add the image", error);
        setImageNotice(
          error instanceof ImageError
            ? error.message
            : "The image couldn't be added. Check your connection and try again.",
        );
      }
    },
    [session],
  );

  // Paste an image anywhere on the page, except into a text field.
  useEffect(() => {
    if (!session) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        session.engine.getState().editing !== null
      )
        return;
      const file = firstImage(event.clipboardData?.files);
      if (!file) return;
      event.preventDefault();
      void addImage(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [session, addImage]);

  // Drop an image file on the board, where it lands.
  useEffect(() => {
    const container = containerRef.current;
    if (!session || !container) return;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      const file = firstImage(event.dataTransfer?.files);
      if (!file) return;
      event.preventDefault();
      const box = container.getBoundingClientRect();
      void addImage(file, { x: event.clientX - box.left, y: event.clientY - box.top });
    };
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);
    return () => {
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
    };
  }, [session, addImage]);

  // A notice about an image goes away by itself.
  useEffect(() => {
    if (imageNotice === null || imageNotice === "Adding the image…") return;
    const timer = setTimeout(() => setImageNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [imageNotice]);

  // The page's colors have already switched (see setThemeChoice); now the canvas.
  useEffect(() => {
    session?.engine.setColorScheme(engineScheme(theme));
  }, [session, theme]);

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
          <Toolbar engine={session.engine} onImage={(file) => void addImage(file)} />
          <SelectionPanel engine={session.engine} />
          <ZoomControls engine={session.engine} onHelp={openHelp} />
          <ExportControls engine={session.engine} />
          <PresenceBar boardId={boardId} board={session.board} />
          <BoardStatus engine={session.engine} board={session.board} />
        </>
      )}
      {imageNotice && (
        <p className="panel notice image-notice" role="status" data-testid="image-notice">
          {imageNotice}
        </p>
      )}
      <ShortcutsHelp open={helpOpen} onClose={closeHelp} />
    </>
  );
}

/** Announces counts to screen readers and explains when the board can't be edited or saved. */
function BoardStatus({ engine, board }: { engine: Engine; board: OpenBoard }) {
  const shapes = useEngineState(engine, (s) => s.shapeCount, 0);
  const selected = useEngineState(engine, (s) => s.selection.length, 0);
  const readOnly = useEngineState(engine, (s) => s.readOnly, false);
  const label = useEngineState(engine, (s) => s.selectionLabel, "");
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
      <p className="visually-hidden" role="status" data-testid="selection-label">
        {label}
      </p>
      {notice && (
        <p className="panel notice" role="alert">
          {notice}
        </p>
      )}
    </>
  );
}
