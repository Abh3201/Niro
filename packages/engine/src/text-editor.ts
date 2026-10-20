import {
  type DocStore,
  defaultAlign,
  editRuns,
  formatRuns,
  type MarkPatch,
  marksAt,
  marksForInsert,
  patchMarks,
  type Shape,
  type ShapeChange,
  type ShapeId,
  type ShapePatch,
  styleIndex,
  type TextEdit,
  type TextMarks,
  type Tx,
} from "@niro/doc";
import type { Camera } from "./camera";
import type { Palette } from "./render";
import {
  inlinePatch,
  isEmptyPatch,
  paragraphsIn,
  rangeTextStyle,
  type TextStyle,
  type TextStylePatch,
} from "./rich-text";
import { shapeCenter } from "./shapes";
import { textStylePatch } from "./structure";
import {
  FONT_FAMILIES,
  FRAME_LABEL_GAP,
  inkColor,
  LINE_HEIGHT,
  MAX_TEXT_LENGTH,
  MEASURE_SIZE,
  type PieceStyle,
  type StyledParagraph,
  styledParagraphs,
  type TextLayouts,
  withHeight,
} from "./text";
import { applyEdit, diffText, mapPosition, rebaseEdit } from "./text-diff";

/** What the text editor needs from the engine. */
export interface TextEditorHost {
  readonly container: HTMLElement;
  readonly doc: DocStore;
  /** A shape as drawn, on the board. */
  shape(id: ShapeId): Shape | undefined;
  /** Edits the document in board coordinates (see `board-tx.ts`). */
  transact(fn: (tx: Tx) => void): void;
  readonly layouts: TextLayouts;
  camera(): Camera;
  palette(): Palette;
  /** Editing started or stopped, or a draft became a shape. */
  changed(): void;
  /** The caret moved, or what's at it changed: the panel shows its formatting (`TextEditor.textStyle`). */
  selectionChanged(): void;
  undo(): void;
  redo(): void;
}

/** Where the selection is, as positions in the text: it runs from `anchor` to `focus`. */
interface Selection {
  readonly anchor: number;
  readonly focus: number;
}

/** Elements that start a line of their own when a browser edits text in them. */
const BLOCKS = new Set([
  "DIV",
  "P",
  "LI",
  "UL",
  "OL",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
]);
const isBlock = (node: Node) => node instanceof HTMLElement && BLOCKS.has(node.tagName);

/** Whether `node` holds anything a line is made of (a block holding text starts a line of its own). */
function hasContent(node: Node): boolean {
  if (node instanceof Text) return node.data.length > 0;
  if (node.nodeName === "BR" || isBlock(node)) return true;
  for (const child of node.childNodes) if (hasContent(child)) return true;
  return false;
}

/** A `<br>` with nothing after it in its line: browsers draw it as nothing, and put it there to hold an empty line open. */
function isTrailingBreak(br: Node, root: Node): boolean {
  for (let n: Node | null = br; n && n !== root && !isBlock(n); n = n.parentNode)
    for (let s = n.nextSibling; s; s = s.nextSibling) if (hasContent(s)) return false;
  return true;
}

/**
 * The text the editor's content stands for, and where `points` (DOM
 * positions) are in it. The editor's own content is a block per paragraph,
 * but a browser editing it can leave other shapes (text between blocks,
 * blocks in blocks, `<br>`s), so this reads what's there as the browser
 * shows it: blocks and `<br>`s break lines, nothing else does.
 */
export function readEditor(
  root: Node,
  points: ReadonlyArray<readonly [Node, number]> = [],
): { text: string; at: number[] } {
  let text = "";
  // A block just ended: the next thing in the text starts a new line.
  let pending = false;
  const at = points.map(() => -1);
  const mark = (node: Node, offset: number, position: number) => {
    points.forEach(([n, o], i) => {
      if (at[i] === -1 && n === node && o === offset) at[i] = position;
    });
  };
  const visit = (node: Node) => {
    if (node instanceof Text) {
      if (node.data.length > 0 && pending) {
        text += "\n";
        pending = false;
      }
      points.forEach(([n, o], i) => {
        if (at[i] === -1 && n === node) at[i] = text.length + Math.min(o, node.data.length);
      });
      text += node.data;
      return;
    }
    if (node.nodeName === "BR") {
      if (isTrailingBreak(node, root)) return;
      if (pending) text += "\n";
      pending = false;
      text += "\n";
      return;
    }
    const block = node !== root && isBlock(node);
    if (block) {
      if (pending || (text.length > 0 && !text.endsWith("\n"))) text += "\n";
      pending = false;
    }
    node.childNodes.forEach((child, i) => {
      mark(node, i, text.length);
      visit(child);
    });
    mark(node, node.childNodes.length, text.length);
    if (block) pending = true;
  };
  visit(root);
  return { text, at: at.map((i) => (i === -1 ? text.length : Math.min(i, text.length))) };
}

/**
 * Edits a shape's text in place, in an editable element laid exactly over it.
 *
 * Canvas can draw text but not edit it: no cursor, selection, spell check,
 * input methods or screen readers. An editable element gets all of those
 * from the browser. It's set in the same fonts, sizes and wrap width as the
 * canvas text, and turned and moved with the shape; the canvas skips that
 * shape's text meanwhile. Each paragraph is a block, and each part of it in
 * one style a span, so formatting shows as it will be drawn.
 *
 * The document, not the element, decides what the text is and how it's
 * formatted: the element is drawn again from it after every change. Typing,
 * line breaks and pastes are taken from the browser's `beforeinput` and
 * written in directly; anything else the browser edits itself (deleting a
 * word, an input method composing) is read back and compared with what was
 * there (`diffText`) to recover the edit. Either way every keystroke goes
 * into the document as a character edit, so others see the typing live and
 * two people typing in one shape both keep their text. Others' typing comes
 * in as it arrives, with this user's cursor kept on the same characters.
 *
 * Formatting applies to what's selected. With nothing selected it's held for
 * what's typed next (as in word processors), except on an empty line, which
 * takes it at once so the line shows it; with no text at all, it's the
 * shape's own (docs/decisions/0014-rich-text.md).
 */
export class TextEditor {
  private el: HTMLDivElement | null = null;
  private id: ShapeId | null = null;
  /** A text shape that isn't in the document yet: it's added with its first character. */
  private draft: Shape | null = null;
  /** The document's text as the editor last showed it. */
  private base = "";
  /** What the editor's content was last drawn from: it's drawn again when this changes. */
  private drawn = "";
  /** Where the selection was last seen. */
  private selection: Selection = { anchor: 0, focus: 0 };
  /** Formatting chosen with nothing selected, for what's typed next at `index`. */
  private pending: { readonly index: number; readonly marks: MarkPatch } | null = null;
  /** An input method (Chinese, Japanese, accents) is composing: hands off the content. */
  private composing = false;
  /** This editor's own write is going into the document. */
  private writing = false;
  /** A frame's name: Enter finishes it instead of starting a new line. */
  private name = false;
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
    const el = document.createElement("div");
    el.dataset.testid = "text-editor";
    try {
      // No bold or italic of the browser's own, and plain text on paste.
      el.contentEditable = "plaintext-only";
    } catch {
      el.contentEditable = "true";
    }
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", String(shape.type !== "frame"));
    el.setAttribute("aria-label", shape.type === "frame" ? "Frame name" : "Text");
    Object.assign(el.style, {
      position: "absolute",
      left: "0",
      top: "0",
      margin: "0",
      padding: "0",
      border: "0",
      outline: "none",
      overflow: "hidden",
      background: "transparent",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      transformOrigin: "0 0",
      userSelect: "text",
      cursor: "text",
    } satisfies Partial<CSSStyleDeclaration>);
    this.el = el;
    this.id = shape.id;
    this.draft = draft ? shape : null;
    this.base = shape.text;
    this.drawn = "";
    this.pending = null;
    this.name = shape.type === "frame";
    const end = shape.text.length;
    this.selection = { anchor: end, focus: end };

    this.listen(el, "beforeinput", (event) => this.beforeInput(event as InputEvent));
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
    this.listen(el, "focusout", (event) => this.focusOut(event as FocusEvent));
    this.listen(document, "selectionchange", () => this.selectionMoved());
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
    this.select(this.selection);
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
    this.pending = null;
    el.remove();

    const { doc } = this.host;
    const shape = wasDraft ? undefined : doc.get(id);
    if (shape?.type === "text" && shape.text.trim() === "")
      this.host.transact((tx) => tx.remove(id));
    doc.checkpoint();
    this.host.changed();
  }

  /**
   * Moves the editor with the shape and the camera, and ends the edit if
   * the shape was deleted or the board can't be edited any more. Call after
   * either moved: the engine does, as it draws.
   */
  update(): void {
    if (!this.el || !this.id) return;
    const shape = this.current();
    if (!shape || this.host.doc.readOnly) {
      this.stop();
      return;
    }
    this.place(shape);
  }

  /** The formatting at the caret, or of what's selected; null when not editing. */
  textStyle(): TextStyle | null {
    const shape = this.current();
    if (!shape) return null;
    this.catchSelection();
    const [start, end] = this.range(shape.text.length);
    const pending = this.pending?.index === start && start === end ? this.pending.marks : null;
    return rangeTextStyle(shape, start, end, pending);
  }

  /** Turns bold, italic, underline or strikethrough on or off for what's selected. */
  toggle(style: "bold" | "italic" | "underline" | "strike"): void {
    const current = this.textStyle();
    if (current) this.format({ [style]: current[style] !== true });
  }

  /** Formats what's selected, the line the caret is on, or what's typed next (see the class comment). */
  format(style: TextStylePatch): void {
    const id = this.id;
    const shape = this.current();
    if (!id || !shape || this.name) return;
    if (this.draft) {
      this.draft = { ...this.draft, ...textStylePatch(this.draft, style) };
      this.place(this.draft);
      this.refocus();
      this.host.selectionChanged();
      return;
    }
    this.catchSelection();
    const { text } = shape;
    const [start, end] = this.range(text.length);
    const patch: Record<string, unknown> = {};
    const formats: Array<{ index: number; length: number; marks: MarkPatch }> = [];
    if (style.valign !== undefined)
      Object.assign(patch, textStylePatch(shape, { valign: style.valign }));
    if (text.length === 0) {
      // Nothing to format: the shape's own settings are what its text will look like.
      const { valign: _, ...rest } = style;
      Object.assign(patch, textStylePatch(shape, rest));
    } else {
      const marks = inlinePatch(style);
      if (!isEmptyPatch(marks)) {
        const emptyLine =
          start === end &&
          (start === 0 || text[start - 1] === "\n") &&
          (start === text.length || text[start] === "\n");
        if (start < end) formats.push({ index: start, length: end - start, marks });
        else if (emptyLine) formats.push({ index: styleIndex(text, start), length: 1, marks });
        else
          this.pending = {
            index: start,
            marks: { ...(this.pending?.index === start ? this.pending.marks : {}), ...marks },
          };
      }
      if (style.align !== undefined) {
        const touched = paragraphsIn(text, start, end);
        for (const p of touched)
          if (p.end < text.length)
            formats.push({ index: p.end, length: 1, marks: { align: style.align } });
        if ((touched[touched.length - 1]?.end ?? 0) === text.length) {
          // The last paragraph has no line break to say how it's aligned: it
          // follows the shape. Others that followed it too keep their look.
          const was = shape.align ?? defaultAlign(shape.type);
          for (const p of paragraphsIn(text, 0, text.length))
            if (
              p.end < text.length &&
              !touched.some((t) => t.start === p.start) &&
              marksAt(text, shape.textRuns, p.end).align === undefined
            )
              formats.push({ index: p.end, length: 1, marks: { align: was } });
          patch.align = style.align;
        }
      }
    }
    if (formats.length > 0 || Object.keys(patch).length > 0) {
      let runs = shape.textRuns;
      for (const f of formats) runs = formatRuns(text, runs, f.index, f.length, f.marks);
      const next: Shape = { ...shape, ...patch, ...(runs ? { textRuns: runs } : {}) };
      if (!runs) delete (next as { textRuns?: unknown }).textRuns;
      const fitted =
        next.type === "text" ? withHeight(next, this.host.layouts.fittedHeight(next)) : null;
      // Formatting is an undo step of its own, apart from the typing around it.
      this.host.doc.checkpoint();
      this.host.transact((tx) => {
        for (const f of formats) tx.formatText(id, f.index, f.length, f.marks);
        if (Object.keys(patch).length > 0 || fitted)
          tx.update(id, { ...patch, ...fitted } as ShapePatch);
      });
    }
    this.refocus();
    this.host.selectionChanged();
  }

  /** Takes the selection from the browser, when it's in the editor (`selectionchange` comes late). */
  private catchSelection(): void {
    // Mid-write, what the browser shows is about to be drawn again.
    if (this.el && document.activeElement === this.el && !this.composing && !this.writing) {
      const live = this.readSelection();
      if (live) this.selection = live;
    }
  }

  /** The shape as it's being edited. */
  private current(): Shape | undefined {
    if (!this.id) return undefined;
    return this.draft ?? this.host.shape(this.id);
  }

  /** The selection, start before end, within text `length` long. */
  private range(length: number): [number, number] {
    const a = Math.min(this.selection.anchor, length);
    const b = Math.min(this.selection.focus, length);
    return a <= b ? [a, b] : [b, a];
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.cleanup.push(() => target.removeEventListener(type, handler));
  }

  /** Focus left the editor: the edit ends, unless it went to the formatting controls. */
  private focusOut(event: FocusEvent): void {
    const to = event.relatedTarget;
    if (to instanceof Element && to.closest("[data-keeps-editor]")) {
      // A dropdown of the panel took focus. The edit ends when focus moves
      // on anywhere but back here or to another of those controls.
      const watch = (e: Event) => {
        const target = e.target;
        if (
          target === this.el ||
          (target instanceof Element && target.closest("[data-keeps-editor]"))
        )
          return;
        document.removeEventListener("focusin", watch);
        this.stop();
      };
      document.addEventListener("focusin", watch);
      this.cleanup.push(() => document.removeEventListener("focusin", watch));
      return;
    }
    // Switching windows blurs too; the edit carries on when focus comes back.
    if (document.hasFocus()) this.stop();
  }

  /** Puts focus back in the editor, on the selection it had (after a dropdown of the panel took it). */
  private refocus(): void {
    const el = this.el;
    if (!el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    this.select(this.selection);
  }

  private keyDown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const enter = event.key === "Enter" && !event.isComposing;
    if (event.key === "Escape" || (enter && (mod || (this.name && !event.shiftKey)))) {
      event.preventDefault();
      this.stop();
    } else if (mod && !event.altKey && (key === "z" || key === "y") && !event.isComposing) {
      // The board's undo, not the browser's own: it knows about others' edits.
      event.preventDefault();
      this.flush();
      if (key === "y" || event.shiftKey) this.host.redo();
      else this.host.undo();
    } else if (
      mod &&
      !event.altKey &&
      !event.shiftKey &&
      !this.name &&
      !event.isComposing &&
      (key === "b" || key === "i" || key === "u")
    ) {
      event.preventDefault();
      this.flush();
      this.toggle(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
    }
  }

  /**
   * Typing, line breaks and pastes go into the document from here, in the
   * formatting they should have; the browser's own formatting is turned away.
   */
  private beforeInput(event: InputEvent): void {
    if (this.composing || event.isComposing) return;
    const type = event.inputType;
    if (type.startsWith("format")) {
      event.preventDefault();
      const toggles: Record<string, "bold" | "italic" | "underline" | "strike"> = {
        formatBold: "bold",
        formatItalic: "italic",
        formatUnderline: "underline",
        formatStrikeThrough: "strike",
      };
      const style = toggles[type];
      if (style && !this.name) this.toggle(style);
      return;
    }
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      this.flush();
      if (type === "historyUndo") this.host.undo();
      else this.host.redo();
      return;
    }
    // Dragging text around inside the editor: not supported.
    if (type === "insertFromDrop" || type === "deleteByDrag") {
      event.preventDefault();
      return;
    }
    let insert: string | null = null;
    if (type === "insertParagraph" || type === "insertLineBreak") insert = "\n";
    else if (type === "insertText" && event.data !== null) insert = event.data;
    else if (type === "insertFromPaste" || type === "insertReplacementText")
      insert = event.dataTransfer?.getData("text/plain") ?? event.data ?? null;
    if (insert === null) return; // Deleting: the browser does it, and `flush` reads it back.
    event.preventDefault();
    insert = insert.replace(/\r\n?/g, "\n");
    // What's replaced: what the browser says (a spelling fix replaces a
    // word), or else what's selected.
    const target = event.getTargetRanges()[0];
    const el = this.el;
    if (!el) return;
    let selection = this.readSelection() ?? this.selection;
    if (target) {
      const { at } = readEditor(el, [
        [target.startContainer, target.startOffset],
        [target.endContainer, target.endOffset],
      ]);
      selection = { anchor: at[0] as number, focus: at[1] as number };
    }
    this.flush();
    this.selection = selection;
    const [start, end] = this.range(this.base.length);
    this.replace(start, end, insert);
  }

  /** Replaces characters `[start, end)` with `insert`, formatted as typing there is, and puts the caret after it. */
  private replace(start: number, end: number, insert: string): void {
    const room = MAX_TEXT_LENGTH - (this.base.length - (end - start));
    const text = insert.slice(0, Math.max(0, room));
    if (text === "" && start === end) return;
    const caret = start + text.length;
    this.selection = { anchor: caret, focus: caret };
    this.write({ index: start, deleteCount: end - start, insert: text });
    this.sync();
  }

  /** How text typed in place of `[index, index + deleteCount)` is formatted. */
  private marksFor(shape: Shape, edit: TextEdit): TextMarks {
    const { text, textRuns } = shape;
    let marks: TextMarks;
    if (edit.deleteCount > 0) {
      // Typing over a selection takes its formatting.
      const { align: _, ...rest } = marksAt(text, textRuns, edit.index);
      marks = rest;
    } else marks = marksForInsert(text, textRuns, edit.index);
    if (this.pending?.index === edit.index) marks = patchMarks(marks, this.pending.marks);
    if (edit.insert.includes("\n")) {
      // A new line break splits a paragraph: both halves are aligned as it was.
      const after = text.indexOf("\n", edit.index + edit.deleteCount);
      const align = after === -1 ? undefined : marksAt(text, textRuns, after).align;
      if (align) marks = { ...marks, align };
    }
    return marks;
  }

  /** Writes `edit`, made to the text as the editor showed it, into the document. */
  private write(edit: TextEdit): void {
    const id = this.id;
    if (!id) return;
    const text = applyEdit(this.base, edit);
    this.writing = true;
    try {
      if (this.draft) {
        const draft = this.draft;
        const marks = this.marksFor(draft, edit);
        const runs = Object.keys(marks).length > 0 ? [{ length: text.length, marks }] : undefined;
        const shape: Shape = { ...draft, text, ...(runs && { textRuns: runs }) };
        this.draft = null;
        this.host.transact((tx) => tx.add({ ...shape, ...this.fit(shape) }));
        this.base = text;
        this.pending = null;
        this.host.changed();
        return;
      }
      const shape = this.host.shape(id);
      if (!shape) return;
      // Others' typing the editor doesn't show yet (it arrived while an
      // input method was composing) moves this edit along.
      const remote = diffText(this.base, shape.text);
      const local = remote ? rebaseEdit(edit, remote) : edit;
      const marks = local.insert === "" ? {} : this.marksFor(shape, local);
      const next = editRuns(
        shape.text,
        shape.textRuns,
        local.index,
        local.deleteCount,
        local.insert,
        marks,
      );
      const { textRuns: _, ...plain } = shape;
      const fitted =
        shape.type === "text"
          ? this.fit({ ...plain, text: next.text, ...(next.runs && { textRuns: next.runs }) })
          : null;
      this.host.transact((tx) => {
        tx.editText(id, local.index, local.deleteCount, local.insert, marks);
        if (fitted) tx.update(id, fitted);
      });
      this.base = text;
      this.pending = null;
    } finally {
      this.writing = false;
    }
    // Others' typing went in too: the editor shows it.
    const now = this.host.shape(id);
    if (now && now.text !== this.base) this.show(now.text);
  }

  /** Writes what the browser edited itself (deleting, an input method) into the document. */
  private flush(): void {
    const el = this.el;
    if (!el || !this.id || this.composing) return;
    const selection = this.readSelection();
    const { text } = readEditor(el);
    if (text === this.base) return;
    if (text.length > MAX_TEXT_LENGTH) {
      // Too long: back to what the document has.
      this.drawn = "";
      this.sync();
      return;
    }
    const edit = diffText(this.base, text, selection?.focus);
    if (!edit) return;
    // Where the browser left the caret, in the text it shows: `write` moves
    // it along if others' typing goes in too.
    if (selection) this.selection = selection;
    this.write(edit);
    this.drawn = ""; // what the browser left isn't how the editor draws text
    this.sync();
  }

  /** Shows the document's text, if the editor is behind it. */
  private catchUp(): void {
    const shape = this.id && !this.draft ? this.host.doc.get(this.id) : undefined;
    if (shape && shape.text !== this.base) this.show(shape.text);
    this.sync();
  }

  /** A text shape's height for its text, keeping its top edge in place. */
  private fit(shape: Shape): ShapePatch | null {
    return shape.type === "text" ? withHeight(shape, this.host.layouts.fittedHeight(shape)) : null;
  }

  /** Someone else typed or formatted in this shape, or this user undid: show it. */
  private docChanged(changes: readonly ShapeChange[]): void {
    if (this.writing || this.draft || this.composing) return;
    for (const change of changes) {
      if (change.kind === "updated" && change.shape.id === this.id) {
        if (change.shape.text !== this.base) this.show(change.shape.text, change.textEdits);
        this.sync();
      }
    }
  }

  /**
   * Takes the document's text, `text`, keeping the cursor on the same
   * characters: through `edits` when they lead there from what the editor
   * shows, or else through a comparison of the two texts.
   */
  private show(text: string, edits?: readonly TextEdit[]): void {
    const before = this.base;
    this.base = text;
    let path = edits && edits.reduce(applyEdit, before) === text ? edits : undefined;
    if (!path) {
      const change = diffText(before, text);
      path = change ? [change] : [];
    }
    const map = (at: number) => path.reduce(mapPosition, at);
    this.selection = { anchor: map(this.selection.anchor), focus: map(this.selection.focus) };
    this.pending = null;
  }

  /** Draws the editor's content again if what it shows changed, and lays it over the shape. */
  private sync(): void {
    const shape = this.current();
    if (shape) this.place(shape);
    this.host.selectionChanged();
  }

  /** The selection in the editor, as positions in its text; null when it's elsewhere. */
  private readSelection(): Selection | null {
    const el = this.el;
    const selection = document.getSelection();
    if (!el || !selection?.anchorNode || !selection.focusNode) return null;
    if (!el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return null;
    const { at } = readEditor(el, [
      [selection.anchorNode, selection.anchorOffset],
      [selection.focusNode, selection.focusOffset],
    ]);
    return { anchor: at[0] as number, focus: at[1] as number };
  }

  private selectionMoved(): void {
    if (this.composing) return;
    const selection = this.readSelection();
    if (!selection) return;
    const { anchor, focus } = this.selection;
    if (selection.anchor === anchor && selection.focus === focus) return;
    this.selection = selection;
    if (
      this.pending &&
      (selection.anchor !== this.pending.index || selection.focus !== this.pending.index)
    )
      this.pending = null;
    this.host.selectionChanged();
  }

  /** Puts the browser's selection at `selection`, in content the editor drew. */
  private select(selection: Selection): void {
    const el = this.el;
    const dom = document.getSelection();
    if (!el || !dom || document.activeElement !== el) return;
    const [anchorNode, anchorOffset] = domPoint(el, selection.anchor);
    const [focusNode, focusOffset] = domPoint(el, selection.focus);
    dom.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }

  /** Draws `shape`'s text into the editor: a block per paragraph, a span per part in one style. */
  private draw(shape: Shape, paragraphs: readonly StyledParagraph[], unit: number): void {
    const el = this.el;
    if (!el) return;
    const palette = this.host.palette();
    const span = (style: PieceStyle, content: Node) => {
      const node = document.createElement("span");
      const ink = inkColor(shape, palette, style.color);
      // The shorthand first: it resets the line height.
      node.style.font = `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${style.size / unit}px ${FONT_FAMILIES[style.family]}`;
      node.style.lineHeight = String(LINE_HEIGHT);
      node.style.textDecorationLine =
        [style.underline && "underline", style.strike && "line-through"]
          .filter(Boolean)
          .join(" ") || "none";
      node.style.color = ink;
      node.style.caretColor = ink;
      node.append(content);
      return node;
    };
    const blocks = paragraphs.map((paragraph) => {
      const block = document.createElement("div");
      block.style.textAlign = paragraph.align;
      // Lines are as tall as their spans: no room for a font of the block's own.
      block.style.fontSize = "0";
      block.style.lineHeight = "0";
      if (paragraph.pieces.length === 0)
        block.append(span(paragraph.style, document.createElement("br")));
      for (const piece of paragraph.pieces)
        block.append(span(piece.style, document.createTextNode(piece.text)));
      return block;
    });
    el.replaceChildren(...blocks);
  }

  /** Lays the editor over the shape's text, at the current zoom, drawing its content again if it changed. */
  private place(shape: Shape): void {
    const el = this.el;
    if (!el) return;
    const camera = this.host.camera();
    const { zoom } = camera;
    const layout = this.host.layouts.get(shape);
    const paragraphs = styledParagraphs(shape, layout);
    // Content is set with its smallest letters at `MEASURE_SIZE` and scaled
    // down, so the browser wraps it as the canvas does (see text.ts); `unit`
    // is world units per CSS pixel of the content.
    let smallest = Number.POSITIVE_INFINITY;
    for (const p of paragraphs) {
      smallest = Math.min(smallest, p.style.size);
      for (const piece of p.pieces) smallest = Math.min(smallest, piece.style.size);
    }
    const unit = smallest / MEASURE_SIZE;
    const key = `${unit}|${inkColor(shape, this.host.palette())}|${JSON.stringify(paragraphs)}`;
    if (key !== this.drawn && !this.composing) {
      this.drawn = key;
      const focused = document.activeElement === el;
      this.draw(shape, paragraphs, unit);
      if (focused) this.select(this.selection);
    }
    const k = unit * zoom; // screen pixels per CSS pixel
    const style = el.style;
    style.width = `${layout.width / unit}px`;
    const height = el.offsetHeight * k;

    // Top-left of the text in the shape's frame (text shapes from their top,
    // a frame's name above it, the rest where their text sits: at the top,
    // the bottom, or centered), turned with the shape, then to screen pixels.
    const top =
      shape.type === "text"
        ? (-shape.h / 2) * zoom
        : shape.type === "frame"
          ? (-shape.h / 2 - FRAME_LABEL_GAP) * zoom - height
          : shape.valign === "top"
            ? layout.y * zoom
            : shape.valign === "bottom"
              ? (layout.y + layout.height) * zoom - height
              : -height / 2;
    const left = layout.x * zoom;
    const cos = Math.cos(shape.rotation);
    const sin = Math.sin(shape.rotation);
    const c = shapeCenter(shape);
    const e = (c.x - camera.x) * zoom + cos * left - sin * top;
    const f = (c.y - camera.y) * zoom + sin * left + cos * top;
    style.transform = `matrix(${cos * k}, ${sin * k}, ${-sin * k}, ${cos * k}, ${e}, ${f})`;
  }
}

/** The DOM position of text position `index` in content the editor drew (a block per paragraph). */
function domPoint(root: HTMLElement, index: number): [Node, number] {
  let at = 0;
  const blocks = [...root.children];
  for (const [i, block] of blocks.entries()) {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    const length = texts.reduce((sum, t) => sum + t.data.length, 0);
    if (index <= at + length || i === blocks.length - 1) {
      let offset = Math.min(index - at, length);
      for (const t of texts) {
        if (offset <= t.data.length) return [t, offset];
        offset -= t.data.length;
      }
      // An empty paragraph: inside its span, before the `<br>` holding it open.
      return [block.firstChild ?? block, 0];
    }
    at += length + 1;
  }
  return [root, 0];
}
