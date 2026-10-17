import { createEngine, type Engine } from "@niro/engine";
import { useEffect, useRef, useState } from "react";
import { openLocalBoard } from "./local-board";
import { SelectionPanel } from "./SelectionPanel";
import { Toolbar } from "./Toolbar";
import { useEngineState } from "./useEngineState";
import { ZoomControls } from "./ZoomControls";

/**
 * Hosts the canvas engine. React renders only the container and the controls
 * around it; the engine creates and draws its own canvases outside React's
 * render cycle, and the document never enters React state.
 */
export function Board({ boardId }: { boardId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [saved, setSaved] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    openLocalBoard(boardId)
      .then((board) => {
        if (cancelled) {
          board.destroy();
          return;
        }
        const instance = createEngine(container, { doc: board.store });
        setEngine(instance);
        setSaved(board.saved);
        cleanup = () => {
          instance.destroy();
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
      setEngine(null);
    };
  }, [boardId]);

  return (
    <>
      <div
        ref={containerRef}
        className="board"
        data-testid="board"
        data-ready={engine ? "true" : "false"}
      />
      {failed && (
        <p className="panel notice" role="alert">
          This board could not be opened. Reload the page to try again.
        </p>
      )}
      {engine && (
        <>
          <Toolbar engine={engine} />
          <SelectionPanel engine={engine} />
          <ZoomControls engine={engine} />
          <BoardStatus engine={engine} saved={saved} />
        </>
      )}
    </>
  );
}

/** Announces counts to screen readers and warns when the board can't be edited or saved. */
function BoardStatus({ engine, saved }: { engine: Engine; saved: boolean }) {
  const shapes = useEngineState(engine, (s) => s.shapeCount, 0);
  const selected = useEngineState(engine, (s) => s.selection.length, 0);
  const readOnly = useEngineState(engine, (s) => s.readOnly, false);
  return (
    <>
      <p className="visually-hidden" role="status" data-testid="board-status">
        {`${shapes} ${shapes === 1 ? "shape" : "shapes"}, ${selected} selected`}
      </p>
      {(readOnly || !saved) && (
        <p className="panel notice" role="alert">
          {readOnly
            ? "This board was saved by a newer version of Niro, so it is read-only here."
            : "This browser isn't saving boards, so changes will be lost when you close the tab."}
        </p>
      )}
    </>
  );
}
