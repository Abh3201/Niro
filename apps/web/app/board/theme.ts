import type { ColorScheme } from "@niro/engine";
import { useSyncExternalStore } from "react";

/**
 * Whether boards are light or dark. A choice of this browser, like your
 * name and color: kept in localStorage and never put in the board, so
 * everyone on a board picks their own. Light until dark is chosen; the
 * system setting isn't followed.
 */
export type ThemeChoice = ColorScheme;

const STORAGE = "niro:theme";
const DEFAULT: ThemeChoice = "light";
const listeners = new Set<() => void>();

/**
 * Inlined in <head>, so a saved dark choice applies before the first paint
 * instead of flashing light. Does what `apply` does.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(STORAGE)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function getThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // No storage: the default.
  }
  return DEFAULT;
}

/** The page's CSS switches on `data-theme`; with none it is light. */
function apply(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice;
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE, choice);
  } catch {
    // Not remembered; it still applies to this page.
  }
  apply(choice);
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  // Another tab changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE && event.key !== null) return;
    apply(getThemeChoice());
    onChange();
  };
  listeners.add(onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, getThemeChoice, () => DEFAULT);
}

/** True when boards are drawn dark. */
export function useDarkTheme(): boolean {
  return useThemeChoice() === "dark";
}
