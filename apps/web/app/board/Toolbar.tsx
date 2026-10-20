import type { Engine, ToolName } from "@niro/engine";
import { type ReactNode, useRef } from "react";
import {
  ArrowIcon,
  EllipseIcon,
  FrameIcon,
  HandIcon,
  ImageIcon,
  LaserIcon,
  LineIcon,
  PenIcon,
  RectangleIcon,
  RedoIcon,
  SelectIcon,
  StickyIcon,
  TextIcon,
  UndoIcon,
} from "./icons";
import { useEngineState } from "./useEngineState";

const TOOLS: ReadonlyArray<{ tool: ToolName; label: string; key: string; icon: ReactNode }> = [
  { tool: "select", label: "Select", key: "V", icon: <SelectIcon /> },
  { tool: "hand", label: "Hand", key: "H", icon: <HandIcon /> },
  { tool: "sticky", label: "Sticky note", key: "N", icon: <StickyIcon /> },
  { tool: "text", label: "Text", key: "T", icon: <TextIcon /> },
  { tool: "rectangle", label: "Rectangle", key: "R", icon: <RectangleIcon /> },
  { tool: "ellipse", label: "Ellipse", key: "O", icon: <EllipseIcon /> },
  { tool: "line", label: "Line", key: "L", icon: <LineIcon /> },
  { tool: "arrow", label: "Arrow", key: "A", icon: <ArrowIcon /> },
  { tool: "pen", label: "Pen", key: "P", icon: <PenIcon /> },
  { tool: "frame", label: "Frame", key: "F", icon: <FrameIcon /> },
  { tool: "laser", label: "Laser pointer", key: "K", icon: <LaserIcon /> },
];

/** The tools a board that can't be edited still has. */
const VIEW_TOOLS: readonly ToolName[] = ["select", "hand", "laser"];

/** Tool picker, the image button and the comments menu, plus undo and redo underneath. */
export function Toolbar({
  engine,
  onImage,
  comments,
}: {
  engine: Engine;
  onImage(file: File): void;
  comments: ReactNode;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useEngineState(engine, (s) => s.tool, "select");
  const readOnly = useEngineState(engine, (s) => s.readOnly, false);
  const canUndo = useEngineState(engine, (s) => s.canUndo, false);
  const canRedo = useEngineState(engine, (s) => s.canRedo, false);

  return (
    <div className="toolbar">
      <div className="panel tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
        {TOOLS.filter(({ tool }) => !readOnly || VIEW_TOOLS.includes(tool)).map(
          ({ tool, label, key, icon }) => (
            <button
              key={tool}
              type="button"
              aria-label={label}
              aria-pressed={active === tool}
              title={`${label} (${key})`}
              data-testid={`tool-${tool}`}
              onClick={() => engine.setTool(tool)}
            >
              {icon}
            </button>
          ),
        )}
        {!readOnly && (
          <>
            <button
              type="button"
              aria-label="Image"
              title="Image (or paste, or drop a file on the board)"
              data-testid="add-image"
              onClick={() => fileInput.current?.click()}
            >
              <ImageIcon />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              data-testid="image-file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) onImage(file);
              }}
            />
          </>
        )}
        {comments}
      </div>
      <div className="panel tools" role="toolbar" aria-label="History" aria-orientation="vertical">
        <button
          type="button"
          aria-label="Undo"
          title="Undo (Ctrl Z)"
          disabled={!canUndo}
          data-testid="undo"
          onClick={engine.undo}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          aria-label="Redo"
          title="Redo (Ctrl Shift Z)"
          disabled={!canRedo}
          data-testid="redo"
          onClick={engine.redo}
        >
          <RedoIcon />
        </button>
      </div>
    </div>
  );
}
