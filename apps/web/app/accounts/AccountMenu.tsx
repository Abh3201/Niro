import { useEffect, useRef, useState } from "react";
import type { Viewer } from "./types";

/** Signs out, then goes to `to`. */
export async function signOut(to = "/"): Promise<void> {
  try {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } finally {
    window.location.assign(to);
  }
}

/** The sign-in page, coming back to `next` (this page by default) afterwards. */
export function signInHref(next?: string): string {
  const back = next ?? (typeof window === "undefined" ? "/" : window.location.pathname);
  return `/signin?next=${encodeURIComponent(back)}`;
}

/**
 * "Sign in", or the signed-in person's avatar with a menu: My boards, any
 * extra items, Sign out.
 */
export function AccountMenu({
  viewer,
  children,
}: {
  viewer: Viewer | null;
  /** More menu items (buttons with class `menu-item`), above Sign out. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!viewer) {
    return (
      <a className="sign-in-link" href={signInHref()} data-testid="sign-in">
        Sign in
      </a>
    );
  }
  return (
    <div className="account" ref={root}>
      <button
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${viewer.name} (${viewer.email})`}
        data-testid="account-button"
        onClick={() => setOpen((on) => !on)}
      >
        {viewer.image ? (
          <img src={viewer.image} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span aria-hidden="true">{initial(viewer.name)}</span>
        )}
        <span className="visually-hidden">Account: {viewer.name}</span>
      </button>
      {open && (
        <div className="panel account-menu" role="menu" data-testid="account-menu">
          <p className="account-who">
            <strong>{viewer.name}</strong>
            <span>{viewer.email}</span>
          </p>
          <a role="menuitem" className="menu-item" href="/boards" data-testid="my-boards">
            My boards
          </a>
          {children}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-testid="sign-out"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function initial(name: string): string {
  return ([...name.trim()][0] ?? "?").toUpperCase();
}
