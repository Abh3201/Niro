import type { Engine } from "@niro/engine";
import { useCallback, useEffect, useRef, useState } from "react";

/** Opens the search panel on Ctrl/⌘ + F, in place of the browser's find (which can't see inside a canvas). */
export function useSearchKey(onOpen: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || event.altKey || event.shiftKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);
}

/**
 * Find text on the board: type to outline every match and jump to the first;
 * Enter and Shift + Enter step through them, Esc closes.
 */
export function SearchPanel({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReturnType<Engine["search"]>>([]);
  const [at, setAt] = useState(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    return () => engine.setHighlights([]);
  }, [engine]);

  /** Looks again (the board may have changed) and shows match `index`, wrapping around. */
  const show = useCallback(
    (text: string, index: number) => {
      const found = engine.search(text);
      setResults(found);
      engine.setHighlights(found);
      if (found.length === 0) {
        setAt(0);
        return;
      }
      const next = ((index % found.length) + found.length) % found.length;
      setAt(next);
      const target = found[next];
      if (target) engine.reveal(target);
    },
    [engine],
  );

  const summary =
    query.trim() === ""
      ? ""
      : results.length === 0
        ? "No matches"
        : `${at + 1} of ${results.length}`;

  return (
    <search className="panel search-panel" data-testid="search">
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="Find text on the board"
        aria-label="Find text on the board"
        data-testid="search-input"
        onChange={(event) => {
          setQuery(event.target.value);
          show(event.target.value, 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            show(query, at + (event.shiftKey ? -1 : 1));
          }
        }}
      />
      <span className="search-count" role="status" data-testid="search-count">
        {summary}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift Enter)"
        disabled={results.length === 0}
        onClick={() => show(query, at - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={results.length === 0}
        onClick={() => show(query, at + 1)}
      >
        ↓
      </button>
      <button type="button" aria-label="Close search" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </search>
  );
}
