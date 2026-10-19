import type { ColorScheme } from "@niro/engine";
import { useSyncExternalStore } from "react";
import { usePrefersDark } from "./usePrefersDark";

/**
 * Whether boards are light or dark. A choice of this browser, like your
 * name and color: kept in localStorage and never put in the board, so
 * everyone on a board picks their own.
 */
export type ThemeChoice = ColorScheme | "system";

const STORAGE = "niro:theme";
const listeners = new Set<() => void>();

/**
 * Inlined in <head>, so a saved choice applies before the first paint
 * instead of flashing the system theme. Does what `apply` does.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(STORAGE)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function getThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // No storage: follow the system.
  }
  return "system";
}

/** The page's CSS switches on `data-theme`; with none it follows the system. */
function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(STORAGE);
    else localStorage.setItem(STORAGE, choice);
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
  return useSyncExternalStore(subscribe, getThemeChoice, () => "system");
}

/** True when boards are drawn dark: chosen, or following a dark system. */
export function useDarkTheme(): boolean {
  const choice = useThemeChoice();
  const systemDark = usePrefersDark();
  return choice === "system" ? systemDark : choice === "dark";
}

/** What the engine is told: null follows the system, as the CSS does. */
export const engineScheme = (choice: ThemeChoice): ColorScheme | null =>
  choice === "system" ? null : choice;
