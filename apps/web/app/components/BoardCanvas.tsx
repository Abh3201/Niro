import { createEngine } from "@niro/engine";
import { useEffect, useRef } from "react";

/**
 * Hosts the canvas engine. React renders only this empty container; the engine
 * creates and draws its own canvases inside it, outside React's render cycle.
 */
export function BoardCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = createEngine(container);
    return () => engine.destroy();
  }, []);

  return <div ref={containerRef} className="board" data-testid="board" />;
}
