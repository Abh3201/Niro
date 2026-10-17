import type { DocStore, Origin, Shape, ShapeChange, ShapeId, Tx } from "@niro/doc";
import { describe, expect, it } from "vitest";
import type { Camera } from "./camera";
import { screenToWorld } from "./camera";
import type { Point } from "./geometry";
import { type EditorHost, Interaction, type ToolName, type ToolPointer } from "./interaction";
import { Scene } from "./scene";

/** A minimal in-memory DocStore: the engine must work with any implementation. */
function memoryDoc(): DocStore {
  const shapes = new Map<ShapeId, Shape>();
  const listeners = new Set<(changes: readonly ShapeChange[], origin: Origin) => void>();
  return {
    readOnly: false,
    get: (id) => shapes.get(id),
    all: () => shapes.values(),
    transact(fn) {
      const changes: ShapeChange[] = [];
      const tx: Tx = {
        add(shape) {
          shapes.set(shape.id, shape);
          changes.push({ kind: "added", shape });
        },
        update(id, patch) {
          const previous = shapes.get(id);
          if (!previous) return;
          const shape = { ...previous, ...patch };
          shapes.set(id, shape);
          changes.push({ kind: "updated", shape, previous });
        },
        editText(id, index, deleteCount, insert) {
          const previous = shapes.get(id);
          if (!previous) return;
          const text = previous.text;
          const shape = {
            ...previous,
            text: text.slice(0, index) + insert + text.slice(index + deleteCount),
          };
          shapes.set(id, shape);
          changes.push({ kind: "updated", shape, previous });
        },
        remove(id) {
          const previous = shapes.get(id);
          if (!previous) return;
          shapes.delete(id);
          changes.push({ kind: "removed", previous });
        },
      };
      fn(tx);
      for (const listener of listeners) listener(changes, "local");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkpoint() {},
    undo() {},
    redo() {},
    canUndo: () => false,
    canRedo: () => false,
  };
}

function setup() {
  const doc = memoryDoc();
  const scene = new Scene(doc);
  doc.subscribe((changes) => scene.apply(changes));
  const camera: Camera = { x: 0, y: 0, zoom: 1 };
  let tool: ToolName = "select";
  let selection: readonly ShapeId[] = [];
  let pending: (() => void) | null = null;
  let interaction: Interaction | null = null;
  /** What the editor was asked to edit: a shape in the document, or a draft. */
  let editing: { id: ShapeId } | { draft: Shape } | null = null;
  const host: EditorHost = {
    doc,
    scene,
    camera: () => camera,
    tool: () => tool,
    setTool(next) {
      // Like the engine: switching tools cancels a running gesture.
      interaction?.cancel();
      tool = next;
    },
    selection: () => selection,
    setSelection(ids) {
      selection = ids.filter((id) => scene.has(id));
    },
    scheduleWrite(write) {
      pending = write;
    },
    flushWrite() {
      const write = pending;
      pending = null;
      write?.();
    },
    overlayChanged() {},
    startEditing(id) {
      editing = { id };
    },
    startDraft(draft) {
      editing = { draft };
    },
    // Ten world units a character, on 24-unit lines (30 tall).
    fittedHeight: (shape) => Math.max(1, Math.ceil((shape.text.length * 10) / shape.w)) * 30,
  };
  interaction = new Interaction(host);
  const pointer = (screen: Point, shiftKey = false): ToolPointer => ({
    pointerId: 1,
    pointerType: "mouse",
    screen,
    world: screenToWorld(camera, screen),
    shiftKey,
  });
  /** Press, move in steps (flushing a frame after each), release. */
  const drag = (from: Point, to: Point, shiftKey = false) => {
    interaction?.pointerDown(pointer(from, shiftKey));
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      interaction?.pointerMove(
        pointer({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, shiftKey),
      );
      host.flushWrite();
    }
    interaction?.pointerUp(pointer(to, shiftKey));
  };
  return {
    doc,
    scene,
    interaction,
    pointer,
    drag,
    tool: () => tool,
    setTool: (t: ToolName) => host.setTool(t),
    selection: () => selection,
    editing: () => editing,
  };
}

describe("Interaction", () => {
  it("drags out a shape, selects it and returns to the select tool", () => {
    const t = setup();
    t.setTool("rectangle");
    t.drag({ x: 100, y: 100 }, { x: 300, y: 250 });
    const shapes = [...t.doc.all()];
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ type: "rectangle", x: 100, y: 100, w: 200, h: 150 });
    expect(t.selection()).toEqual([shapes[0]?.id]);
    expect(t.tool()).toBe("select");
  });

  it("drops a default-size shape on a click", () => {
    const t = setup();
    t.setTool("sticky");
    t.interaction.pointerDown(t.pointer({ x: 500, y: 500 }));
    t.interaction.pointerUp(t.pointer({ x: 500, y: 500 }));
    expect([...t.doc.all()][0]).toMatchObject({ type: "sticky", x: 400, y: 400, w: 200, h: 200 });
  });

  it("moves a shape by dragging it, and Escape puts it back", () => {
    const t = setup();
    t.setTool("rectangle");
    t.drag({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.drag({ x: 50, y: 50 }, { x: 150, y: 80 });
    expect([...t.doc.all()][0]).toMatchObject({ x: 100, y: 30 });

    t.interaction.pointerDown(t.pointer({ x: 150, y: 80 }));
    t.interaction.pointerMove(t.pointer({ x: 400, y: 400 }));
    expect(t.interaction.cancel()).toBe(true);
    expect([...t.doc.all()][0]).toMatchObject({ x: 100, y: 30 });
  });

  it("selects with a marquee and clears on an empty click", () => {
    const t = setup();
    t.setTool("rectangle");
    t.drag({ x: 0, y: 0 }, { x: 50, y: 50 });
    t.setTool("ellipse");
    t.drag({ x: 100, y: 0 }, { x: 150, y: 50 });
    t.interaction.pointerDown(t.pointer({ x: 500, y: 500 }));
    t.interaction.pointerUp(t.pointer({ x: 500, y: 500 }));
    expect(t.selection()).toEqual([]);

    t.drag({ x: -10, y: -10 }, { x: 120, y: 20 });
    expect(t.selection()).toHaveLength(2);
  });

  it("hands touch presses on empty space back to the input controller", () => {
    const t = setup();
    const touch = { ...t.pointer({ x: 10, y: 10 }), pointerType: "touch" };
    expect(t.interaction.pointerDown(touch)).toBe(false);
  });

  it("places a text shape where the text tool clicks, editing it before it exists", () => {
    const t = setup();
    t.setTool("text");
    t.interaction.pointerDown(t.pointer({ x: 100, y: 200 }));
    t.interaction.pointerUp(t.pointer({ x: 100, y: 200 }));
    expect(t.tool()).toBe("select");
    // Nothing in the document until something is typed.
    expect([...t.doc.all()]).toHaveLength(0);
    const editing = t.editing();
    if (!editing || !("draft" in editing)) throw new Error("no draft");
    expect(editing.draft).toMatchObject({ type: "text", x: 100, y: 185, w: 240, h: 30, text: "" });
  });

  it("sets a text shape's width with a drag of the text tool", () => {
    const t = setup();
    t.setTool("text");
    t.drag({ x: 400, y: 200 }, { x: 100, y: 260 });
    const editing = t.editing();
    if (!editing || !("draft" in editing)) throw new Error("no draft");
    expect(editing.draft).toMatchObject({ x: 100, y: 200, w: 300 });
  });

  it("edits a text shape the text tool clicks on, rather than adding one", () => {
    const t = setup();
    t.setTool("text");
    t.interaction.pointerDown(t.pointer({ x: 100, y: 200 }));
    t.interaction.pointerUp(t.pointer({ x: 100, y: 200 }));
    const editing = t.editing();
    if (!editing || !("draft" in editing)) throw new Error("no draft");
    t.doc.transact((tx) => tx.add({ ...editing.draft, text: "hello" }));

    t.setTool("text");
    t.interaction.pointerDown(t.pointer({ x: 120, y: 200 }));
    t.interaction.pointerUp(t.pointer({ x: 120, y: 200 }));
    expect(t.editing()).toEqual({ id: editing.draft.id });
  });

  it("starts writing on a new sticky note", () => {
    const t = setup();
    t.setTool("sticky");
    t.interaction.pointerDown(t.pointer({ x: 500, y: 500 }));
    t.interaction.pointerUp(t.pointer({ x: 500, y: 500 }));
    const sticky = [...t.doc.all()][0];
    expect(t.editing()).toEqual({ id: sticky?.id });
  });

  it("edits text with a double click, or starts a text shape on empty space", () => {
    const t = setup();
    t.setTool("rectangle");
    t.drag({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.setTool("line");
    t.drag({ x: 200, y: 0 }, { x: 300, y: 0 });
    const [rectangle] = [...t.doc.all()];

    t.interaction.doubleClick(t.pointer({ x: 250, y: 0 }));
    expect(t.editing()).toBeNull(); // lines hold no text
    t.interaction.doubleClick(t.pointer({ x: 50, y: 50 }));
    expect(t.editing()).toEqual({ id: rectangle?.id });
    t.interaction.doubleClick(t.pointer({ x: 500, y: 500 }));
    expect(t.editing()).toMatchObject({ draft: { type: "text", x: 500 } });
  });

  it("refits a text shape's height to its text when it's resized narrower", () => {
    const t = setup();
    t.doc.transact((tx) =>
      tx.add({
        id: "t1" as ShapeId,
        type: "text",
        x: 0,
        y: 0,
        w: 240,
        h: 30,
        rotation: 0,
        parentId: null,
        index: "a0",
        color: "black",
        text: "x".repeat(20), // 200 wide in the test host: one line
      }),
    );
    t.interaction.pointerDown(t.pointer({ x: 10, y: 10 }));
    t.interaction.pointerUp(t.pointer({ x: 10, y: 10 }));
    // The right edge's handle, dragged left: 120 wide fits 12 characters a line.
    t.drag({ x: 240, y: 15 }, { x: 120, y: 15 });
    expect(t.doc.get("t1" as ShapeId)).toMatchObject({ x: 0, y: 0, w: 120, h: 60 });
  });

  it("leaves text typed during a drag alone when the drag is cancelled", () => {
    const t = setup();
    t.setTool("sticky");
    t.drag({ x: 0, y: 0 }, { x: 100, y: 100 });
    const id = [...t.doc.all()][0]?.id as ShapeId;
    t.interaction.pointerDown(t.pointer({ x: 50, y: 50 }));
    t.interaction.pointerMove(t.pointer({ x: 80, y: 80 }));
    t.doc.transact((tx) => tx.editText(id, 0, 0, "typed by someone else"));
    t.interaction.cancel();
    expect(t.doc.get(id)).toMatchObject({ x: 0, y: 0, text: "typed by someone else" });
  });
});
