import type { Engine, EngineState } from "@niro/engine";
import { useSyncExternalStore } from "react";

/**
 * Reads one value from the engine and re-renders only when that value
 * changes. `select` must return a primitive or a reference the engine keeps
 * stable (like `selection`), or the component re-renders on every frame.
 */
export function useEngineState<T>(
  engine: Engine,
  select: (state: EngineState) => T,
  serverValue: T,
): T {
  return useSyncExternalStore(
    engine.subscribe,
    () => select(engine.getState()),
    () => serverValue,
  );
}
