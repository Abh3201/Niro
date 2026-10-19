import { createEngine, type Engine } from "@niro/engine";
import { useEffect, useRef, useState } from "react";
import { ZoomControls } from "./ZoomControls";

/**
 * Hosts the canvas engine. React renders only the container and the controls
 * around it; the engine creates and draws its own canvases outside React's
 * render cycle.
 */
export function BoardCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const instance = createEngine(container);
    setEngine(instance);
    return () => {
      instance.destroy();
      setEngine(null);
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className="board" data-testid="board" />
      {engine && <ZoomControls engine={engine} />}
    </>
  );
}
