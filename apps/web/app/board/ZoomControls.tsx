import type { Engine } from "@niro/engine";
import type { ReactNode } from "react";
import { MoonIcon, SunIcon } from "./icons";
import { setThemeChoice, useDarkTheme } from "./theme";
import { useEngineState } from "./useEngineState";
import { usePrefersDark } from "./usePrefersDark";

/**
 * Zoom out / current zoom (click to reset) / zoom in, the board menu, the
 * light/dark switch and the shortcuts list.
 */
export function ZoomControls({
  engine,
  onHelp,
  menu,
}: {
  engine: Engine;
  onHelp: () => void;
  menu: ReactNode;
}) {
  // Select just the zoom level, so panning doesn't re-render this component.
  const zoom = useEngineState(engine, (s) => s.camera.zoom, 1);
  const percent = Math.round(zoom * 100);
  const dark = useDarkTheme();
  const systemDark = usePrefersDark();
  // Switching back to what the system uses goes back to following it.
  const toggleTheme = () =>
    setThemeChoice(!dark === systemDark ? "system" : dark ? "light" : "dark");

  return (
    <div className="panel zoom-controls" role="toolbar" aria-label="Zoom">
      <button
        type="button"
        onClick={engine.zoomOut}
        aria-label="Zoom out"
        title="Zoom out (Ctrl -)"
      >
        −
      </button>
      <button
        type="button"
        onClick={engine.resetZoom}
        aria-label={`Zoom ${percent}%, reset to 100%`}
        title="Reset to 100% (Ctrl 0)"
        data-testid="zoom-level"
      >
        {percent}%
      </button>
      <button type="button" onClick={engine.zoomIn} aria-label="Zoom in" title="Zoom in (Ctrl =)">
        +
      </button>
      <span className="divider" aria-hidden="true" />
      {menu}
      <button
        type="button"
        onClick={toggleTheme}
        aria-pressed={dark}
        aria-label="Dark board"
        title={dark ? "Switch to a light board" : "Switch to a dark board"}
        data-testid="theme-toggle"
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </button>
      <button
        type="button"
        onClick={onHelp}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        data-testid="shortcuts-button"
      >
        ?
      </button>
    </div>
  );
}
