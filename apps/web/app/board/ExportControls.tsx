import type { Engine } from "@niro/engine";
import { useState } from "react";
import { useEngineState } from "./useEngineState";

const FORMATS = [
  { format: "png", label: "PNG" },
  { format: "svg", label: "SVG" },
] as const;

/** Downloads the selection, or the whole board, as an image. */
export function ExportControls({ engine }: { engine: Engine }) {
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
    <div className="panel export-controls" role="toolbar" aria-label="Export">
      <button
        type="button"
        disabled={slides === 0}
        aria-label="Present the frames"
        title={
          slides === 0
            ? "Present: draw a frame first. Each frame is a slide (Shift Alt P)"
            : `Present ${slides} ${slides === 1 ? "frame" : "frames"}, one at a time (Shift Alt P)`
        }
        data-testid="present-start"
        onClick={() => {
          engine.present();
          // The board hears the arrow keys, not this button.
          document.querySelector<HTMLElement>('[data-testid="board"]')?.focus();
        }}
      >
        Present
      </button>
      {FORMATS.map(({ format, label }) => (
        <button
          key={format}
          type="button"
          disabled={empty || busy}
          aria-label={`Export ${what} as ${label}`}
          title={`Export ${what} as ${label}`}
          data-testid={`export-${format}`}
          onClick={() => void download(format)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
