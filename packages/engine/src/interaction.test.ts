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
    pressure: 0.5,
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
    flush: () => host.flushWrite(),
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
        points: [],
        from: null,
        to: null,
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

  it("draws with the pen, adding each stroke when it's finished and keeping the pen", () => {
    const t = setup();
    t.setTool("pen");
    t.interaction.pointerDown(t.pointer({ x: 0, y: 0 }));
    t.interaction.pointerMove(t.pointer({ x: 50, y: 20 }));
    // A fast pen: the browser merged several moves into one event.
    t.interaction.pointerMove({
      ...t.pointer({ x: 100, y: 0 }),
      samples: [
        { x: 70, y: 15, pressure: 0.5 },
        { x: 100, y: 0, pressure: 0.5 },
      ],
    });
    // Only in the overlay while it's drawn.
    expect(t.interaction.drawing()).toHaveLength(4);
    expect([...t.doc.all()]).toHaveLength(0);
    t.interaction.pointerUp(t.pointer({ x: 100, y: 0 }));

    const [stroke] = [...t.doc.all()];
    expect(stroke).toMatchObject({ type: "freehand", color: "black" });
    expect(stroke?.points).toHaveLength(12);
    expect(stroke?.x).toBeLessThan(0);
    expect((stroke?.x ?? 0) + (stroke?.w ?? 0)).toBeGreaterThan(100);
    expect(t.tool()).toBe("pen");
    expect(t.interaction.drawing()).toBeNull();

    // Escape drops a stroke being drawn.
    t.interaction.pointerDown(t.pointer({ x: 0, y: 100 }));
    t.interaction.pointerMove(t.pointer({ x: 50, y: 100 }));
    t.interaction.cancel();
    expect([...t.doc.all()]).toHaveLength(1);
  });

  /** Two boxes with an arrow dragged from inside one to inside the other. */
  function arrowBetweenBoxes() {
    const t = setup();
    t.setTool("rectangle");
    t.drag({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.setTool("rectangle");
    t.drag({ x: 300, y: 0 }, { x: 400, y: 100 });
    const [a, b] = [...t.doc.all()].map((shape) => shape.id);
    t.setTool("arrow");
    t.drag({ x: 50, y: 50 }, { x: 350, y: 50 });
    const arrow = [...t.doc.all()].find((shape) => shape.type === "arrow") as Shape;
    return { ...t, a: a as ShapeId, b: b as ShapeId, arrow: arrow.id };
  }

  it("attaches an arrow to the shapes it's dragged between", () => {
    const t = arrowBetweenBoxes();
    expect(t.doc.get(t.arrow)).toMatchObject({ from: t.a, to: t.b });
    expect(t.selection()).toEqual([t.arrow]);
    expect(t.tool()).toBe("select");
    // Drawn between the outlines, not from where the drag started.
    expect(t.scene.get(t.arrow)).toMatchObject({ x: 108, y: 50, w: 184, h: 0 });
  });

  it("lets an arrow go when it's moved without its shapes, and keeps them when they move with it", () => {
    const t = arrowBetweenBoxes();
    t.drag({ x: 200, y: 50 }, { x: 200, y: 250 });
    expect(t.doc.get(t.arrow)).toMatchObject({ from: null, to: null, x: 108, y: 250, w: 184 });

    const u = arrowBetweenBoxes();
    u.drag({ x: -10, y: -10 }, { x: 410, y: 110 });
    expect(u.selection()).toHaveLength(3);
    u.drag({ x: 50, y: 50 }, { x: 50, y: 250 });
    expect(u.doc.get(u.arrow)).toMatchObject({ from: u.a, to: u.b });
    expect(u.scene.get(u.arrow)).toMatchObject({ x: 108, y: 250 });

    // Escape puts a moved arrow back, attached again.
    const v = arrowBetweenBoxes();
    v.interaction.pointerDown(v.pointer({ x: 200, y: 50 }));
    v.interaction.pointerMove(v.pointer({ x: 200, y: 300 }));
    v.flush();
    expect(v.doc.get(v.arrow)?.from).toBeNull();
    v.interaction.cancel();
    expect(v.doc.get(v.arrow)).toMatchObject({ from: v.a, to: v.b });
  });

  it("moves an arrow's free end with it, wherever its attached end is drawn", () => {
    const t = setup();
    t.setTool("rectangle");
    t.drag({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.setTool("arrow");
    t.drag({ x: 50, y: 50 }, { x: 600, y: 50 });
    const arrow = [...t.doc.all()].find((shape) => shape.type === "arrow") as Shape;
    expect(arrow.to).toBeNull();
    // Both selected, then moved down 200.
    t.drag({ x: -10, y: -10 }, { x: 610, y: 110 });
    t.drag({ x: 50, y: 50 }, { x: 50, y: 250 });
    const drawn = t.scene.get(arrow.id) as Shape;
    expect(drawn.x + drawn.w).toBeCloseTo(600);
    expect(drawn.y + drawn.h).toBeCloseTo(250);
  });

  it("attaches an arrow's end to the shape it's dropped on, and lets go on empty space", () => {
    const t = arrowBetweenBoxes();
    t.setTool("ellipse");
    t.drag({ x: 300, y: 300 }, { x: 400, y: 400 });
    const c = [...t.doc.all()].find((shape) => shape.type === "ellipse")?.id;
    // Select the arrow, then drag its end handle onto the ellipse.
    t.interaction.pointerDown(t.pointer({ x: 200, y: 50 }));
    t.interaction.pointerUp(t.pointer({ x: 200, y: 50 }));
    t.drag({ x: 292, y: 50 }, { x: 350, y: 350 });
    expect(t.doc.get(t.arrow)).toMatchObject({ from: t.a, to: c });

    const end = t.scene.get(t.arrow) as Shape;
    t.drag({ x: end.x + end.w, y: end.y + end.h }, { x: 600, y: 600 });
    expect(t.doc.get(t.arrow)).toMatchObject({ from: t.a, to: null });
    const loose = t.scene.get(t.arrow) as Shape;
    expect(loose.x + loose.w).toBeCloseTo(600);
    expect(loose.y + loose.h).toBeCloseTo(600);
  });
});
