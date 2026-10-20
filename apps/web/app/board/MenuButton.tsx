import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

/** How long the pointer can be off a hover-opened menu before it closes. */
const HOVER_GRACE_MS = 200;

/**
 * A button that opens a small menu of related actions next to it, so several
 * rarely used buttons take one button's room. Hovering with a mouse opens it
 * (and leaving closes it); a click keeps it open until another click, a click
 * elsewhere, Escape or Tab moving focus away. A disclosure, not an ARIA menu: the
 * items are ordinary buttons reached with Tab.
 */
export function MenuButton({
  label,
  title,
  icon,
  testId,
  active = false,
  badge,
  side,
  children,
}: {
  label: string;
  title: string;
  icon: ReactNode;
  testId: string;
  /** Shows the button highlighted, for a mode one of the items turned on. */
  active?: boolean;
  badge?: number;
  /** Where the menu opens: to the right of a left-hand toolbar, or above a bottom one. */
  side: "right" | "above";
  /** The items; call close after an item has done its work. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState<false | "hover" | "click">(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();

  const cancelLeave = () => clearTimeout(leaveTimer.current);
  const close = useCallback(() => {
    clearTimeout(leaveTimer.current);
    setOpen(false);
  }, []);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close();
    };
    // Escape closes the menu, wherever focus is, and doesn't also reach the board.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      const focusInside = wrapper.current?.contains(document.activeElement) ?? false;
      close();
      if (focusInside) trigger.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only previews the menu; the button opens it for everyone else.
    <div
      ref={wrapper}
      className="menu"
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        cancelLeave();
        setOpen((current) => current || "hover");
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        cancelLeave();
        leaveTimer.current = setTimeout(
          () => setOpen((current) => (current === "hover" ? false : current)),
          HOVER_GRACE_MS,
        );
      }}
      onBlur={(event) => {
        // Tabbing away closes it. A click elsewhere is the pointerdown above's to
        // handle: some browsers don't focus a clicked button, so focus "leaving"
        // for nowhere may just be a click on an item.
        const next = event.relatedTarget as Node | null;
        if (open && next && !wrapper.current?.contains(next)) close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={badge ? `${label}, ${badge}` : label}
        aria-expanded={open !== false}
        aria-controls={id}
        title={title}
        data-testid={testId}
        className={active ? "active" : undefined}
        onClick={() => setOpen((current) => (current === "click" ? false : "click"))}
      >
        {icon}
        {badge ? (
          <span className="menu-badge" aria-hidden="true">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </button>
      {open && (
        <div id={id} className={`panel menu-popover menu-popover--${side}`}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
