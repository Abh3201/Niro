import type { Shape } from "@niro/doc";
import { type Engine, parseClipping, serializeClipping } from "@niro/engine";
import { useEffect } from "react";
import type { Assets } from "./assets";
import { firstImage } from "./assets";

/**
 * Copy, cut and paste on the board, through the page's clipboard events
 * (Ctrl/Cmd + C, X, V, and the browser's menus).
 *
 * A copy writes three versions: Niro's own type, read back by a paste in
 * any Niro tab; HTML carrying the same data in an attribute, for browsers
 * that drop custom types between pages (and so that a paste into a
 * document gets the text); and plain text, the shapes' text. A paste takes
 * Niro's shapes first, then an image file, then plain text as a text shape.
 */

/** Niro's clipboard type. Browsers keep custom types for pastes into pages. */
const MIME = "web application/x-niro-shapes";
const LEGACY_MIME = "application/x-niro-shapes";
const HTML_ATTRIBUTE = "data-niro-shapes";

interface ClipboardOptions {
  readonly engine: Engine | null;
  readonly boardId: string;
  readonly assets: Assets | null;
  /** Adds an image file from the clipboard. */
  addImage(file: File): void;
  /** Tells the person something about a paste; null clears it. */
  notify(message: string | null): void;
}

/** True when the clipboard event is for a text field (or the text editor), not the board. */
function forTextField(event: ClipboardEvent, engine: Engine): boolean {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable) ||
    engine.getState().editing !== null
  )
    return true;
  // Text selected on the page (in the share panel, say) is the browser's to copy.
  const selection = document.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== "";
}

export function useClipboard({ engine, boardId, assets, addImage, notify }: ClipboardOptions) {
  useEffect(() => {
    if (!engine || !assets) return;

    const write = (event: ClipboardEvent, shapes: readonly Shape[]) => {
      const data = event.clipboardData;
      if (!data || shapes.length === 0) return;
      event.preventDefault();
      const json = serializeClipping({ board: boardId, shapes });
      const text = shapes
        .map((shape) => shape.text)
        .filter((t) => t.trim() !== "")
        .join("\n");
      data.setData(MIME, json);
      data.setData(LEGACY_MIME, json);
      data.setData(
        "text/html",
        `<meta charset="utf-8"><div ${HTML_ATTRIBUTE}="${escapeHtml(json)}">${escapeHtml(text)}</div>`,
      );
      data.setData("text/plain", text);
      // A paste into another board needs the image files: keep them in this browser.
      const images = [...new Set(shapes.flatMap((s) => (s.asset ? [s.asset] : [])))];
      void assets.stash(images).catch((error: unknown) => {
        console.warn("Could not keep copied images for pasting elsewhere", error);
      });
    };

    const onCopy = (event: ClipboardEvent) => {
      if (forTextField(event, engine)) return;
      write(event, engine.copySelection());
    };

    const onCut = (event: ClipboardEvent) => {
      if (forTextField(event, engine) || engine.getState().readOnly) return;
      write(event, engine.cutSelection());
    };

    const onPaste = (event: ClipboardEvent) => {
      if (forTextField(event, engine) || engine.getState().readOnly) return;
      const data = event.clipboardData;
      if (!data) return;
      const clipping = readClipping(data);
      if (clipping) {
        event.preventDefault();
        void pasteShapes(engine, assets, boardId, clipping, notify);
        return;
      }
      const file = firstImage(data.files);
      if (file) {
        event.preventDefault();
        addImage(file);
        return;
      }
      const text = data.getData("text/plain");
      if (text.trim() !== "") {
        event.preventDefault();
        engine.pasteText(text);
      }
    };

    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
      window.removeEventListener("paste", onPaste);
    };
  }, [engine, boardId, assets, addImage, notify]);
}

/** Niro's shapes on the clipboard, from its own type or the HTML version; null when there are none. */
function readClipping(data: DataTransfer) {
  for (const type of [MIME, LEGACY_MIME]) {
    const json = data.getData(type);
    if (json) return parseClipping(json);
  }
  const html = data.getData("text/html");
  if (!html.includes(HTML_ATTRIBUTE)) return null;
  const element = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector(`[${HTML_ATTRIBUTE}]`);
  const json = element?.getAttribute(HTML_ATTRIBUTE);
  return json ? parseClipping(json) : null;
}

/**
 * Pastes shapes. From another board, images are uploaded here first, from
 * the copies the browser kept when they were copied; any that can't be are
 * left out, and the person is told.
 */
async function pasteShapes(
  engine: Engine,
  assets: Assets,
  boardId: string,
  clipping: NonNullable<ReturnType<typeof parseClipping>>,
  notify: (message: string | null) => void,
): Promise<void> {
  const images = [...new Set(clipping.shapes.flatMap((s) => (s.asset ? [s.asset] : [])))];
  if (clipping.board === boardId || images.length === 0) {
    engine.paste(clipping.shapes);
    return;
  }
  notify("Adding the images…");
  const moved = new Map<string, string>();
  await Promise.all(
    images.map(async (asset) => {
      const id = await assets.adopt(asset).catch(() => null);
      if (id) moved.set(asset, id);
    }),
  );
  const shapes = clipping.shapes.filter((s) => !s.asset || moved.has(s.asset));
  engine.paste(shapes, (asset) => moved.get(asset) ?? asset);
  const missing = clipping.shapes.length - shapes.length;
  notify(
    missing === 0
      ? null
      : `${missing === 1 ? "An image" : `${missing} images`} couldn't be copied to this board. Add ${missing === 1 ? "it" : "them"} again from the file.`,
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
