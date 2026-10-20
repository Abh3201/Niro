import type { Engine } from "@niro/engine";
import { useState } from "react";
import { MoreIcon } from "./icons";
import { MenuButton } from "./MenuButton";
import { useEngineState } from "./useEngineState";

const FORMATS = [
  { format: "png", label: "PNG" },
  { format: "svg", label: "SVG" },
] as const;

/**
 * The bottom right menu: present the frames, version history, and download
 * the selection, or the whole board, as an image.
 */
export function BoardMenu({ engine, onHistory }: { engine: Engine; onHistory: () => void }) {
  const selected = useEngineState(engine, (s) => s.selection.length > 0, false);
  const empty = useEngineState(engine, (s) => s.shapeCount === 0, true);
  const slides = useEngineState(engine, (s) => s.presentable, 0);
  const [busy, setBusy] = useState(false);
  const what = selected ? "the selection" : "the board";

  const download = async (format: "png" | "svg") => {
    setBusy(true);
    try {
      const blob = await engine.exportImage(format);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `niro-${selected ? "selection" : "board"}.${format}`;
      link.click();
      // Give the download time to start before the URL goes.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      console.error("Export failed", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MenuButton
      label="Present, history and export"
      title="Present, version history and export"
      icon={<MoreIcon />}
      testId="board-menu"
      side="above"
    >
      {(close) => (
        <>
          <button
            type="button"
            disabled={slides === 0}
            title={
              slides === 0
                ? "Present: draw a frame first. Each frame is a slide (Shift Alt P)"
                : `Present ${slides} ${slides === 1 ? "frame" : "frames"}, one at a time (Shift Alt P)`
            }
            data-testid="present-start"
            onClick={() => {
              close();
              engine.present();
              // The board hears the arrow keys, not this button.
              document.querySelector<HTMLElement>('[data-testid="board"]')?.focus();
            }}
          >
            Present the frames<kbd>Shift Alt P</kbd>
          </button>
          <button
            type="button"
            title="Version history: look at earlier versions and restore one"
            data-testid="history-open"
            onClick={() => {
              close();
              onHistory();
            }}
          >
            Version history
          </button>
          {FORMATS.map(({ format, label }) => (
            <button
              key={format}
              type="button"
              disabled={empty || busy}
              title={`Export ${what} as ${label}`}
              data-testid={`export-${format}`}
              onClick={() => void download(format)}
            >
              {`Export ${what} as ${label}`}
            </button>
          ))}
        </>
      )}
    </MenuButton>
  );
}
