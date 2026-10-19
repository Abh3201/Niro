import type { DocStore, Shape, ShapeChange, ShapeId, ShapePatch, TextEdit } from "@niro/doc";
import type { Camera } from "./camera";
import type { Palette } from "./render";
import { shapeCenter } from "./shapes";
import {
  FONT_FAMILY,
  inkColor,
  LINE_HEIGHT,
  MAX_TEXT_LENGTH,
  type TextLayouts,
  withHeight,
} from "./text";
import { applyEdit, diffText, mapPosition, rebaseEdit } from "./text-diff";

/** What the text editor needs from the engine. */
export interface TextEditorHost {
  readonly container: HTMLElement;
  readonly doc: DocStore;
  readonly layouts: TextLayouts;
  camera(): Camera;
  palette(): Palette;
  /** Editing started or stopped, or a draft became a shape. */
  changed(): void;
  undo(): void;
  redo(): void;
}

/**
 * Edits a shape's text in place, in a `<textarea>` laid exactly over it.
 *
 * Canvas can draw text but not edit it: no cursor, selection, spell check,
 * input methods or screen readers. A real text field gets all of those from
 * the browser. It's transparent, set in the same font, size and wrap width
 * as the canvas text, and turned and moved with the shape; the canvas skips
 * that shape's text meanwhile.
 *
 * Every keystroke goes into the document as a character edit (the textarea
 * reports its whole value; `diffText` recovers the edit), so others see the
 * typing live and two people typing in one shape both keep their text.
 * Others' typing comes into the textarea as it arrives, with this user's
 * cursor kept on the same characters.
 */
export class TextEditor {
  private el: HTMLTextAreaElement | null = null;
  private id: ShapeId | null = null;
  /** A text shape that isn't in the document yet: it's added with its first character. */
  private draft: Shape | null = null;
  /** The document's text as the textarea last showed it. */
  private base = "";
  /** An input method (Chinese, Japanese, accents) is composing: hands off the textarea. */
  private composing = false;
  /** This editor's own write is going into the document. */
  private writing = false;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly host: TextEditorHost) {}

  /** The shape being edited, or the draft's id. */
  get editing(): ShapeId | null {
    return this.id;
  }

  /**
   * Starts editing `shape`'s text, ending any other edit. With `draft`, the
   * shape is new and only goes into the document if something is typed.
   */
  start(shape: Shape, draft = false): void {
    this.stop();
    const { doc, container } = this.host;
    if (doc.readOnly) return;
    const el = document.createElement("textarea");
    el.dataset.testid = "text-editor";
    el.setAttribute("aria-label", "Text");
    el.maxLength = MAX_TEXT_LENGTH;
    el.value = shape.text;
    Object.assign(el.style, {
      position: "absolute",
      left: "0",
      top: "0",
      margin: "0",
      padding: "0",
      border: "0",
      outline: "none",
      resize: "none",
      overflow: "hidden",
      background: "transparent",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      fontFamily: FONT_FAMILY,
      lineHeight: String(LINE_HEIGHT),
      transformOrigin: "0 0",
      userSelect: "text",
    } satisfies Partial<CSSStyleDeclaration>);
    this.el = el;
    this.id = shape.id;
    this.draft = draft ? shape : null;
    this.base = shape.text;

    this.listen(el, "input", () => {
      if (!this.composing) this.flush();
    });
    this.listen(el, "compositionstart", () => {
      this.composing = true;
    });
    this.listen(el, "compositionend", () => {
      this.composing = false;
      this.flush();
      this.catchUp();
    });
    this.listen(el, "keydown", (event) => this.keyDown(event as KeyboardEvent));
    this.listen(el, "blur", () => {
      // Switching windows blurs too; the edit carries on when focus comes back.
      if (document.hasFocus()) this.stop();
    });
    // Typing near the board's edge makes the browser scroll the caret into
    // view, scrolling the board's container, which must never move.
    this.listen(container, "scroll", () => {
      container.scrollTop = 0;
      container.scrollLeft = 0;
    });
    this.cleanup.push(doc.subscribe((changes) => this.docChanged(changes)));

    container.append(el);
    this.place(shape);
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // Typing is an undo step of its own, apart from whatever came before.
    doc.checkpoint();
    this.host.changed();
  }

  /** Ends the edit. A text shape left empty is deleted. */
  stop(): void {
    const el = this.el;
    const id = this.id;
    if (!el || !id) return;
    this.composing = false;
    this.flush();
    const wasDraft = this.draft !== null;
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
    this.el = null;
    this.id = null;
    this.draft = null;
    el.remove();

    const { doc } = this.host;
    const shape = wasDraft ? undefined : doc.get(id);
    if (shape?.type === "text" && shape.text.trim() === "") doc.transact((tx) => tx.remove(id));
    doc.checkpoint();
    this.host.changed();
  }

  /**
   * Moves the textarea with the shape and the camera, and ends the edit if
   * the shape was deleted or the board can't be edited any more. Call after
   * either moved: the engine does, as it draws.
   */
  update(): void {
    if (!this.el || !this.id) return;
    const shape = this.draft ?? this.host.doc.get(this.id);
    if (!shape || this.host.doc.readOnly) {
      this.stop();
      return;
    }
    this.place(shape);
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.cleanup.push(() => target.removeEventListener(type, handler));
  }

  private keyDown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === "Escape" || (mod && event.key === "Enter")) {
      event.preventDefault();
      this.stop();
    } else if (mod && !event.altKey && (key === "z" || key === "y") && !event.isComposing) {
      // The board's undo, not the textarea's own: it knows about others' edits.
      event.preventDefault();
      this.flush();
      if (key === "y" || event.shiftKey) this.host.redo();
      else this.host.undo();
    }
  }

  /** Someone else typed in this shape, or this user undid: show it. */
  private docChanged(changes: readonly ShapeChange[]): void {
    if (this.writing || this.draft || this.composing) return;
    for (const change of changes) {
      if (change.kind === "updated" && change.shape.id === this.id) {
        this.show(change.shape.text, change.textEdits);
      }
    }
  }

  /** Writes what was typed since the last write into the document. */
  private flush(): void {
    const el = this.el;
    const id = this.id;
    if (!el || !id || this.composing) return;
    const edit = diffText(this.base, el.value, el.selectionEnd);
    if (!edit) return;
    const { doc } = this.host;
    this.writing = true;
    try {
      if (this.draft) {
        const shape = { ...this.draft, text: el.value };
        this.draft = null;
        doc.transact((tx) => tx.add({ ...shape, ...this.fit(shape) }));
        this.base = el.value;
        this.host.changed();
        return;
      }
      const shape = doc.get(id);
      if (!shape) return;
      // Others' typing the textarea doesn't show yet (it arrived while an
      // input method was composing) moves this edit along.
      const remote = diffText(this.base, shape.text);
      const local = remote ? rebaseEdit(edit, remote) : edit;
      const fitted =
        shape.type === "text" ? this.fit({ ...shape, text: applyEdit(shape.text, local) }) : null;
      doc.transact((tx) => {
        tx.editText(id, local.index, local.deleteCount, local.insert);
        if (fitted) tx.update(id, fitted);
      });
      this.base = el.value;
    } finally {
      this.writing = false;
    }
    if (doc.get(id)?.text !== el.value) this.catchUp();
  }

  /** Shows the document's text, if the textarea is behind it. */
  private catchUp(): void {
    const shape = this.id && !this.draft ? this.host.doc.get(this.id) : undefined;
    if (shape) this.show(shape.text);
  }

  /** A text shape's height for its text, keeping its top edge in place. */
  private fit(shape: Shape): ShapePatch | null {
    return shape.type === "text" ? withHeight(shape, this.host.layouts.fittedHeight(shape)) : null;
  }

  /**
   * Puts `text`, the document's, in the textarea, keeping the cursor on the
   * same characters: through `edits` when they lead there from what the
   * textarea shows, or else through a comparison of the two texts.
   */
  private show(text: string, edits?: readonly TextEdit[]): void {
    const el = this.el;
    if (!el || this.composing) return;
    this.base = text;
    if (el.value === text) return;
    let path = edits && edits.reduce(applyEdit, el.value) === text ? edits : undefined;
    if (!path) {
      const change = diffText(el.value, text);
      path = change ? [change] : [];
    }
    const map = (at: number) => path.reduce(mapPosition, at);
    const { selectionStart, selectionEnd, selectionDirection } = el;
    el.value = text;
    el.setSelectionRange(map(selectionStart), map(selectionEnd), selectionDirection ?? undefined);
  }

  /** Lays the textarea over the shape's text, at the current zoom. */
  private place(shape: Shape): void {
    const el = this.el;
    if (!el) return;
    const camera = this.host.camera();
    const { zoom } = camera;
    const layout = this.host.layouts.get(shape);
    const fontPx = layout.fontSize * zoom;
    const ink = inkColor(shape, this.host.palette());
    const style = el.style;
    style.fontSize = `${fontPx}px`;
    style.width = `${layout.width * zoom}px`;
    style.textAlign = layout.align;
    style.color = ink;
    style.caretColor = ink;
    // The browser wraps the textarea itself, so ask it how tall the text is.
    style.height = "0px";
    const height = Math.max(el.scrollHeight, fontPx * LINE_HEIGHT);
    style.height = `${height}px`;
    el.scrollTop = 0;

    // Top-left of the text in the shape's frame (text shapes from their top,
    // the rest centered), turned with the shape, then to screen pixels.
    const top = shape.type === "text" ? (-shape.h / 2) * zoom : -height / 2;
    const left = layout.x * zoom;
    const cos = Math.cos(shape.rotation);
    const sin = Math.sin(shape.rotation);
    const c = shapeCenter(shape);
    const e = (c.x - camera.x) * zoom + cos * left - sin * top;
    const f = (c.y - camera.y) * zoom + sin * left + cos * top;
    style.transform = `matrix(${cos}, ${sin}, ${-sin}, ${cos}, ${e}, ${f})`;
  }
}
