import { useEffect, useRef } from "react";

const MOD = "Ctrl/⌘";

const SECTIONS: ReadonlyArray<{ title: string; rows: ReadonlyArray<[string, string]> }> = [
  {
    title: "Tools",
    rows: [
      ["V", "Select"],
      ["H", "Hand (pan)"],
      ["N", "Sticky note"],
      ["T", "Text"],
      ["R", "Rectangle"],
      ["O", "Ellipse"],
      ["L", "Line"],
      ["A", "Arrow"],
      ["P", "Pen"],
      ["F", "Frame"],
      ["K", "Laser pointer (hold and drag; everyone sees the trail)"],
    ],
  },
  {
    title: "Selection",
    rows: [
      ["Tab / Shift + Tab", "Next / previous shape"],
      ["Esc", "Clear the selection, or stop a drag"],
      [`${MOD} + A`, "Select everything"],
      ["Enter", "Edit the selected shape's text"],
      ["Arrow keys", "Nudge (with Shift: 10 px)"],
      ["Delete", "Delete"],
      [`${MOD} + C / X / V`, "Copy / cut / paste (also to other boards and tabs)"],
      [`${MOD} + D`, "Duplicate"],
      [`${MOD} + G`, "Group"],
      [`${MOD} + Shift + G`, "Ungroup"],
      ["] / [", "Bring forward / send backward"],
      ["Shift + ] / [", "Bring to front / send to back"],
    ],
  },
  {
    title: "Board",
    rows: [
      [`${MOD} + Z`, "Undo"],
      [`${MOD} + Shift + Z`, "Redo"],
      [`${MOD} + = / - / 0`, "Zoom in / out / to 100%"],
      ["Space + drag", "Pan"],
      ["Alt + drag", "Move without snapping to other shapes"],
      ["Alt + draw (pen)", "Draw on the board, not on the sticky note under the pen"],
      ["Shift + Alt + L", "Lock or unlock the selected shapes"],
      ["?", "This list"],
    ],
  },
];

/**
 * The keyboard shortcuts, in a dialog that `?` (or the button) opens. A
 * native modal dialog keeps focus inside it, and Esc closes it.
 */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes a modal dialog by itself; the click only handles the backdrop.
    <dialog
      ref={dialog}
      className="panel shortcuts"
      aria-labelledby="shortcuts-title"
      data-testid="shortcuts"
      onClose={onClose}
      // A click on the backdrop (the dialog itself, outside its content) closes it.
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="shortcuts-content">
        <header>
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            <dl>
              {section.rows.map(([keys, action]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}

/** Calls `onOpen` when `?` is typed anywhere but in a text field. */
export function useHelpKey(onOpen: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, dialog"))
      )
        return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);
}
