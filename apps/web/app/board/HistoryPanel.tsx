import { createYDocStore } from "@niro/doc/yjs";
import { centerOn, createEngine, type Engine } from "@niro/engine";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { OpenBoard } from "./open-board";
import { getThemeChoice } from "./theme";
import { VersionError, type VersionInfo } from "./versions";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const nameOf = (version: VersionInfo) =>
  version.label ?? (version.auto ? "Saved automatically" : "Saved version");

/**
 * Saved versions of the board: look at one, save the board as it is, or put
 * one back. Looking opens the version in a second, view-only engine on a
 * document of its own; restoring edits the live board to match (a change
 * everyone receives, and undo reverts), after saving the board as it was.
 */
export function HistoryPanel({
  board,
  onClose,
  onRestored,
}: {
  board: OpenBoard;
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const loaded = useRef<Uint8Array | null>(null);
  const canEdit = board.role === "edit" && !board.store.readOnly;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // The boards' engines handle keys themselves (Esc included), which would keep the dialog's own Esc from firing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const refresh = useCallback(async () => {
    try {
      const list = await board.versions.list();
      setVersions(list);
      return list;
    } catch (error) {
      setMessage(error instanceof VersionError ? error.message : "Couldn't load the versions.");
      setVersions([]);
      return [];
    }
  }, [board]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The selected version, drawn in a second engine on a copy of its own.
  useEffect(() => {
    const container = preview.current;
    if (!selected || !container) return;
    let cancelled = false;
    let engine: Engine | null = null;
    let doc: Y.Doc | null = null;
    let store: ReturnType<typeof createYDocStore> | null = null;
    loaded.current = null;
    setState("loading");
    board.versions
      .load(selected)
      .then((bytes) => {
        if (cancelled) return;
        loaded.current = bytes;
        doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        store = createYDocStore(doc, { readOnly: true });
        engine = createEngine(container, {
          doc: store,
          loadImage: board.assets.load,
          colorScheme: getThemeChoice(),
        });
        const { bounds } = engine.overview();
        const width = container.clientWidth || 600;
        const height = container.clientHeight || 400;
        if (bounds) {
          const zoom = Math.min(
            1,
            (width * 0.9) / Math.max(1, bounds.maxX - bounds.minX),
            (height * 0.9) / Math.max(1, bounds.maxY - bounds.minY),
          );
          engine.setCamera(
            centerOn(
              { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
              { width, height },
              zoom,
            ),
          );
        }
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
      engine?.destroy();
      store?.destroy();
      doc?.destroy();
    };
  }, [selected, board]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await board.versions.save(label.trim() || null);
      setLabel("");
      await refresh();
      setSelected(saved.id);
    } catch (error) {
      setMessage(error instanceof VersionError ? error.message : "The version couldn't be saved.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const version = versions?.find((v) => v.id === selected);
    const bytes = loaded.current;
    if (!version || !bytes) return;
    setBusy(true);
    setMessage(null);
    try {
      // The board as it is now, so the restore can itself be undone later, even by someone else.
      await board.versions.save(`Before restoring ${when.format(version.createdAt)}`);
    } catch (error) {
      // A save made a moment ago (429) already holds almost the same board; anything else is a reason to stop.
      if (!(error instanceof VersionError && error.message.startsWith("Saved a moment ago"))) {
        setMessage(
          `${error instanceof VersionError ? error.message : "The board couldn't be saved first."} Nothing was restored.`,
        );
        setBusy(false);
        return;
      }
    }
    if (board.store.restore(bytes)) {
      onRestored(
        `Restored “${nameOf(version)}” (${when.format(version.createdAt)}). Ctrl+Z undoes it.`,
      );
      onClose();
    } else {
      setMessage("This version was saved by a newer version of Niro and can't be restored here.");
      setBusy(false);
    }
  };

  const current = versions?.find((v) => v.id === selected);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes a modal dialog by itself; the click only handles the backdrop.
    <dialog
      ref={dialog}
      className="panel history"
      aria-labelledby="history-title"
      data-testid="history"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <header>
        <h2 id="history-title">Version history</h2>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="history-body">
        <div className="history-side">
          {canEdit && (
            <form
              className="history-save"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <input
                type="text"
                value={label}
                maxLength={80}
                placeholder="Name this version (optional)"
                aria-label="Name for the new version"
                data-testid="history-label"
                onChange={(event) => setLabel(event.target.value)}
              />
              <button type="submit" disabled={busy} data-testid="history-save">
                Save
              </button>
            </form>
          )}
          {versions === null && <p className="history-hint">Loading…</p>}
          {versions?.length === 0 && (
            <p className="history-hint" data-testid="history-empty">
              No versions yet. Niro saves one by itself while you work, and you can save one
              {canEdit ? " above" : " if you can edit"}.
            </p>
          )}
          <ul className="history-list" aria-label="Saved versions">
            {versions?.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  aria-pressed={version.id === selected}
                  data-testid="history-version"
                  onClick={() => setSelected(version.id)}
                >
                  <span className="history-name">{nameOf(version)}</span>
                  <span className="history-time">{when.format(version.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="history-main">
          <div
            ref={preview}
            className="history-preview"
            data-testid="history-preview"
            data-state={state}
          />
          {!selected && <p className="history-hint">Pick a version to look at it.</p>}
          {state === "failed" && <p role="alert">That version couldn't be loaded.</p>}
          {message && (
            <p role="alert" data-testid="history-message">
              {message}
            </p>
          )}
          {current && (
            <footer>
              <span className="history-hint">
                Restoring puts the board back as it was, as a new change everyone gets. The board as
                it is now is saved first.
              </span>
              <button
                type="button"
                disabled={!canEdit || busy || state !== "ready"}
                title={canEdit ? undefined : "Only people who can edit can restore"}
                data-testid="history-restore"
                onClick={() => void restore()}
              >
                Restore this version
              </button>
            </footer>
          )}
        </div>
      </div>
    </dialog>
  );
}
