import type { Shape, ShapeId, Tx } from "@niro/doc";
import { describe, expect, it } from "vitest";
import { transact } from "./board-tx";
import { Scene } from "./scene";
import {
  adoptInto,
  duplicate,
  group,
  hasLocked,
  isLocked,
  movers,
  noteAt,
  noteFor,
  placeNew,
  placeOnNote,
  releaseOutside,
  remove,
  reorder,
  reparentOnMove,
  selectableUnit,
  sharedColor,
  sharedLineStyle,
  sharedTextStyle,
  stepInto,
  styleTargets,
  textStylePatch,
  ungroup,
} from "./structure";
import { memoryDoc } from "./test-doc";

const id = (s: string) => s as ShapeId;

const box = (
  name: string,
  x: number,
  y: number,
  w = 10,
  h = 10,
  patch: Partial<Shape> = {},
): Shape => ({
  id: id(name),
  type: "rectangle",
  x,
  y,
  w,
  h,
  rotation: 0,
  parentId: null,
  index: "a0",
  color: "blue",
  text: "",
  points: [],
  from: null,
  to: null,
  ...patch,
});

const frame = (name: string, x: number, y: number, w: number, h: number, patch = {}) =>
  box(name, x, y, w, h, { type: "frame", color: "grey", ...patch });
const groupShape = (name: string, patch: Partial<Shape> = {}) =>
  box(name, 0, 0, 0, 0, { type: "group", color: "black", ...patch });

function board(shapes: Shape[]) {
  const doc = memoryDoc(shapes);
  const scene = new Scene(doc);
  doc.subscribe((changes) => scene.apply(changes));
  const edit = <T>(fn: (tx: Tx) => T): T => {
    let result: T | undefined;
    transact(doc, scene, (tx) => {
      result = fn(tx);
    });
    return result as T;
  };
  const stored = (name: string) => doc.get(id(name)) as Shape;
  return { doc, scene, edit, stored };
}

describe("selecting in groups", () => {
  // g1 holds g2 and c; g2 holds a and b. f is a frame holding s.
  const shapes = () => [
    groupShape("g1", { index: "a0" }),
    groupShape("g2", { parentId: id("g1"), index: "a0" }),
    box("a", 0, 0, 10, 10, { parentId: id("g2"), index: "a0" }),
    box("b", 20, 0, 10, 10, { parentId: id("g2"), index: "a1" }),
    box("c", 40, 0, 10, 10, { parentId: id("g1"), index: "a1" }),
    frame("f", 100, 0, 100, 100, { index: "a1" }),
    box("s", 120, 20, 10, 10, { parentId: id("f"), index: "a0" }),
  ];

  it("selects the outermost group, then the level the selection has stepped into", () => {
    const { scene } = board(shapes());
    expect(selectableUnit(scene, id("a"), [])).toBe("g1");
    expect(selectableUnit(scene, id("a"), [id("c")])).toBe("g2");
    expect(selectableUnit(scene, id("a"), [id("b")])).toBe("a");
    // Frames don't hide what's in them.
    expect(selectableUnit(scene, id("s"), [])).toBe("s");
  });

  it("steps one level into a group", () => {
    const { scene } = board(shapes());
    expect(stepInto(scene, id("g1"), id("a"))).toBe("g2");
    expect(stepInto(scene, id("g2"), id("a"))).toBe("a");
    expect(stepInto(scene, id("g2"), id("c"))).toBeNull();
  });

  it("works out a group's box from what's in it, following moves", () => {
    const { scene, edit } = board(shapes());
    expect(scene.get(id("g2"))).toMatchObject({ x: 0, y: 0, w: 30, h: 10 });
    expect(scene.get(id("g1"))).toMatchObject({ x: 0, y: 0, w: 50, h: 10 });
    edit((tx) => tx.update(id("a"), { y: -20 }));
    expect(scene.get(id("g2"))).toMatchObject({ y: -20, h: 30 });
    expect(scene.get(id("g1"))).toMatchObject({ y: -20, h: 30 });
  });

  it("recolors what's in a group, and a frame itself", () => {
    const { scene } = board(shapes());
    expect(styleTargets(scene, [id("g1"), id("f")]).sort()).toEqual(["a", "b", "c", "f"]);
    expect(sharedColor(scene, [id("g1")])).toBe("blue");
    expect(sharedColor(scene, [id("g1"), id("f")])).toBeNull();
  });
});

describe("group and ungroup", () => {
  it("groups shapes where the topmost was, keeping their order", () => {
    const { scene, edit, stored } = board([
      box("a", 0, 0, 10, 10, { index: "a0" }),
      box("b", 20, 0, 10, 10, { index: "a1" }),
      box("c", 40, 0, 10, 10, { index: "a2" }),
      box("d", 60, 0, 10, 10, { index: "a3" }),
    ]);
    const g = edit((tx) => group(scene, tx, [id("c"), id("a")])) as ShapeId;
    expect(scene.childrenOf(g)).toEqual(["a", "c"]);
    expect(scene.childrenOf(null)).toEqual(["b", g, "d"]);
    expect(scene.get(g)).toMatchObject({ x: 0, w: 50 });
    expect(stored("a").parentId).toBe(g);

    const freed = edit((tx) => ungroup(scene, tx, [g]));
    expect(freed).toEqual(["a", "c"]);
    expect(scene.has(g)).toBe(false);
    expect(scene.childrenOf(null)).toEqual(["b", "a", "c", "d"]);
  });

  it("needs two shapes, and groups in the innermost frame that holds them all", () => {
    const { scene, edit } = board([
      frame("f", 0, 0, 200, 200),
      box("a", 10, 10, 10, 10, { parentId: id("f"), index: "a0" }),
      box("b", 30, 10, 10, 10, { parentId: id("f"), index: "a1" }),
      box("out", 300, 0, 10, 10, { index: "a1" }),
    ]);
    expect(edit((tx) => group(scene, tx, [id("a")]))).toBeNull();
    const inside = edit((tx) => group(scene, tx, [id("a"), id("b")])) as ShapeId;
    expect(scene.parentOf(inside)).toBe("f");
    // Shapes in a frame and outside it are grouped outside it, above the frame.
    const across = edit((tx) => group(scene, tx, [inside, id("out")])) as ShapeId;
    expect(scene.parentOf(across)).toBeNull();
    expect(scene.childrenOf(across)).toEqual([inside, "out"]);
    expect(scene.childrenOf(null)).toEqual(["f", across]);
  });
});

describe("remove", () => {
  it("deletes what's in a frame with it, and a group once it's empty", () => {
    const { scene, edit } = board([
      frame("f", 0, 0, 100, 100),
      box("in", 10, 10, 10, 10, { parentId: id("f") }),
      groupShape("g", { index: "a1" }),
      box("a", 200, 0, 10, 10, { parentId: id("g"), index: "a0" }),
      box("b", 220, 0, 10, 10, { parentId: id("g"), index: "a1" }),
    ]);
    edit((tx) => remove(scene, tx, [id("f"), id("a")]));
    expect(scene.has(id("in"))).toBe(false);
    expect(scene.has(id("g"))).toBe(true);
    edit((tx) => remove(scene, tx, [id("b")]));
    expect(scene.has(id("g"))).toBe(false);
    expect(scene.size).toBe(0);
  });

  it("leaves arrows from deleted shapes where they're drawn", () => {
    const { scene, edit, stored } = board([
      box("a", 0, 0, 10, 10),
      box("b", 100, 0, 10, 10, { index: "a1" }),
      box("arrow", -50, -50, 1, 1, {
        type: "arrow",
        index: "a2",
        from: id("a"),
        to: id("b"),
      }),
    ]);
    const drawn = scene.get(id("arrow")) as Shape;
    edit((tx) => remove(scene, tx, [id("b")]));
    expect(stored("arrow")).toMatchObject({ from: "a", to: null, w: drawn.w, x: drawn.x });
  });
});

describe("duplicate", () => {
  it("copies a frame with what's in it, attaching copied arrows to copies", () => {
    const { scene, edit } = board([
      frame("f", 0, 0, 200, 200),
      box("a", 10, 10, 10, 10, { parentId: id("f"), index: "a0" }),
      box("b", 100, 10, 10, 10, { parentId: id("f"), index: "a1" }),
      box("arrow", 0, 0, 1, 1, {
        type: "arrow",
        parentId: id("f"),
        index: "a2",
        from: id("a"),
        to: id("b"),
      }),
    ]);
    const [copy] = edit((tx) => duplicate(scene, tx, [id("f")], 24));
    const inner = scene.childrenOf(copy as ShapeId).map((c) => scene.get(c) as Shape);
    expect(scene.get(copy as ShapeId)).toMatchObject({ type: "frame", x: 24, y: 24 });
    expect(inner.map((s) => s.type)).toEqual(["rectangle", "rectangle", "arrow"]);
    expect(inner[0]).toMatchObject({ x: 34, y: 34 });
    const arrow = inner[2] as Shape;
    expect([arrow.from, arrow.to]).toEqual([inner[0]?.id, inner[1]?.id]);
    expect(scene.childrenOf(null)).toEqual(["f", copy]);
  });
});

describe("locks", () => {
  it("lock what's in a locked group or frame, and refuse edits to anything that holds a lock", () => {
    const { scene } = board([
      frame("f", 0, 0, 200, 200, { locked: true }),
      box("in", 10, 10, 10, 10, { parentId: id("f") }),
      box("free", 300, 0),
      groupShape("g"),
      box("held", 400, 0, 10, 10, { parentId: id("g"), locked: true }),
    ]);
    expect(isLocked(scene, id("in"))).toBe(true);
    expect(isLocked(scene, id("free"))).toBe(false);
    // The group itself isn't locked, but one shape in it is: moving the group would move that.
    expect(isLocked(scene, id("g"))).toBe(false);
    expect(hasLocked(scene, [id("g")])).toBe(true);
    expect(hasLocked(scene, [id("free")])).toBe(false);
    expect(hasLocked(scene, [id("free"), id("f")])).toBe(true);
  });

  it("starts copies unlocked", () => {
    const { scene, edit } = board([box("a", 0, 0, 10, 10, { locked: true })]);
    const [copy] = edit((tx) => duplicate(scene, tx, [id("a")], 24));
    expect(scene.get(copy as ShapeId)?.locked).toBeUndefined();
    expect(scene.get(id("a"))?.locked).toBe(true);
  });
});

describe("sharedLineStyle", () => {
  const line = (name: string, patch: Partial<Shape> = {}) =>
    box(name, 0, 0, 10, 0, { type: "line", color: "black", ...patch });

  it("reports what lines share, and null where they differ or a shape isn't a line", () => {
    const { scene } = board([
      line("a", { dash: "dashed" }),
      line("b", { dash: "dashed", thickness: "thick" }),
      box("arrow", 0, 0, 10, 0, { type: "arrow", color: "black" }),
      box("r", 0, 0),
    ]);
    expect(sharedLineStyle(scene, [id("a"), id("b")])).toEqual({
      dash: "dashed",
      thickness: null,
      head: "none",
      route: null,
      routable: false,
    });
    // An arrow's default head is at its end; a line's is none.
    expect(sharedLineStyle(scene, [id("a"), id("arrow")])?.head).toBeNull();
    expect(sharedLineStyle(scene, [id("a"), id("r")])).toBeNull();
    expect(sharedLineStyle(scene, [])).toBeNull();
  });
});

describe("reorder", () => {
  it("moves shapes among their own siblings", () => {
    const { scene, edit } = board([
      frame("f", 0, 0, 200, 200),
      box("a", 10, 10, 10, 10, { parentId: id("f"), index: "a0" }),
      box("b", 30, 10, 10, 10, { parentId: id("f"), index: "a1" }),
      box("top", 300, 0, 10, 10, { index: "a1" }),
    ]);
    const keys = reorder(scene, [id("a")], "front");
    edit((tx) => {
      for (const [shape, index] of keys) tx.update(shape, { index });
    });
    expect(scene.childrenOf(id("f"))).toEqual(["b", "a"]);
    expect(scene.childrenOf(null)).toEqual(["f", "top"]);
  });
});

describe("frames", () => {
  const shapes = () => [
    frame("f", 0, 0, 200, 200),
    box("in", 10, 10, 20, 20, { parentId: id("f"), index: "a0" }),
    box("out", 300, 10, 20, 20, { index: "a1" }),
    groupShape("g", { parentId: id("f"), index: "a1" }),
    box("g1", 50, 50, 10, 10, { parentId: id("g") }),
  ];

  it("moves a shape into the frame its center lands in, and out again", () => {
    const { scene } = board(shapes());
    const out = scene.get(id("out")) as Shape;
    const moving = new Set([id("out")]);
    expect(reparentOnMove(scene, [out], moving, -250, 0).get(id("out"))).toMatchObject({
      parentId: "f",
    });
    expect(reparentOnMove(scene, [out], moving, -50, 0).size).toBe(0);
    const inside = scene.get(id("in")) as Shape;
    expect(
      reparentOnMove(scene, [inside], new Set([id("in")]), 300, 0).get(id("in")),
    ).toMatchObject({ parentId: null });
  });

  it("keeps shapes in a group with their group, and takes no frame that's moving", () => {
    const { scene } = board(shapes());
    const member = scene.get(id("g1")) as Shape;
    expect(reparentOnMove(scene, [member], new Set([id("g1")]), 500, 0).size).toBe(0);
    const f = scene.get(id("f")) as Shape;
    expect(reparentOnMove(scene, [f], new Set([id("f"), id("in")]), 10, 10).size).toBe(0);
  });

  it("puts a line in a frame only when both its ends are in it", () => {
    const { scene } = board(shapes());
    const line = box("line", 20, 100, 100, 0, { type: "line" });
    expect(placeNew(scene, line).parentId).toBe("f");
    expect(placeNew(scene, { ...line, w: 300 }).parentId).toBeNull();
  });

  it("puts new shapes on top in their frame, and new frames at the bottom", () => {
    const { scene } = board(shapes());
    const sticky = placeNew(scene, box("new", 100, 100));
    expect(sticky.parentId).toBe("f");
    expect(sticky.index > "a1").toBe(true);
    const inner = placeNew(scene, frame("f2", 100, 100, 50, 50));
    expect(inner.parentId).toBe("f");
    expect(inner.index < "a0").toBe(true);
  });

  it("never puts a frame in a frame smaller than it, drawn or dragged", () => {
    const { scene } = board(shapes());
    // Drawn around f: it stays at the top level (and adoptInto takes f in).
    expect(placeNew(scene, frame("big", -50, -50, 300, 300)).parentId).toBeNull();
    // Dragged so its center lands on f, but bigger than f.
    const wide = frame("wide", 400, 0, 600, 100, { index: "a2" });
    const { scene: withWide } = board([...shapes(), wide]);
    expect(reparentOnMove(withWide, [wide], new Set([id("wide")]), -600, 0).size).toBe(0);
  });

  it("takes in shapes a new frame is drawn around, and lets go of those left outside", () => {
    const { scene, edit } = board([
      box("a", 10, 10, 20, 20, { index: "a0" }),
      box("b", 90, 10, 20, 20, { index: "a1" }),
      frame("f", 0, 0, 100, 100, { index: "Zz" }),
    ]);
    edit((tx) => adoptInto(scene, tx, id("f")));
    // b sticks out of the frame, so it stays where it is.
    expect(scene.childrenOf(id("f"))).toEqual(["a"]);
    expect(scene.childrenOf(null)).toEqual(["f", "b"]);

    // Narrowed past a, the frame lets go of it, which stays where it is.
    edit((tx) => tx.update(id("f"), { w: 5 }));
    edit((tx) => releaseOutside(scene, tx, id("f")));
    expect(scene.childrenOf(id("f"))).toEqual([]);
    expect(scene.childrenOf(null)).toEqual(["f", "b", "a"]);
    expect(scene.get(id("a"))).toMatchObject({ x: 10, y: 10 });
  });

  it("clips what's in a frame, and hides what's under its inside from clicks", () => {
    const { scene } = board([
      box("under", 50, 50, 20, 20, { index: "Zz" }),
      frame("f", 0, 0, 100, 100),
      box("in", 80, 80, 40, 40, { parentId: id("f") }),
    ]);
    expect(scene.framesAround(id("in"))).toEqual(["f"]);
    expect(scene.hit({ x: 90, y: 90 }, 0)?.id).toBe("in");
    // The part of "in" outside the frame isn't drawn, so it can't be clicked.
    expect(scene.hit({ x: 110, y: 110 }, 0)).toBeUndefined();
    // The frame's surface covers "under".
    expect(scene.hit({ x: 60, y: 60 }, 0)).toBeUndefined();
    // Its edge and its name pick the frame.
    expect(scene.hit({ x: 0, y: 50 }, 2)?.id).toBe("f");
    expect(scene.hit({ x: 50, y: -10 }, 0)?.id).toBe("f");
    expect(scene.frameAt({ x: 60, y: 60 })).toBe("f");
    expect(scene.frameAt({ x: 60, y: 60 }, new Set([id("f")]))).toBeNull();
  });
});

describe("ink on sticky notes", () => {
  const note = (patch: Partial<Shape> = {}) =>
    box("note", 100, 100, 100, 100, { type: "sticky", color: "yellow", ...patch });
  const ink = (name: string, x: number, y: number, patch: Partial<Shape> = {}) =>
    box(name, x, y, 20, 20, {
      type: "freehand",
      parentId: id("note"),
      points: [0, 0, 50],
      ...patch,
    });

  it("moves ink with its note, in a frame too", () => {
    const { scene, edit, stored } = board([
      frame("f", 0, 0, 500, 500),
      note({ parentId: id("f") }),
      ink("i", 110, 110, { parentId: id("note") }),
    ]);
    // Stored from the frame's corner, and the note's own children follow it.
    expect(stored("i")).toMatchObject({ x: 110, y: 110 });
    edit((tx) => {
      for (const sid of movers(scene, [id("note")])) {
        const s = scene.get(sid) as Shape;
        tx.update(sid, { x: s.x + 30, y: s.y });
      }
    });
    expect(scene.get(id("i"))).toMatchObject({ x: 140, y: 110 });
    expect(movers(scene, [id("note")])).toEqual([id("note"), id("i")]);
  });

  it("finds the note under a point, unless something covers it or it's locked", () => {
    const { scene } = board([note(), box("over", 150, 150, 100, 100, { index: "a1" })]);
    expect(noteAt(scene, { x: 110, y: 110 })).toBe("note");
    expect(noteAt(scene, { x: 160, y: 160 })).toBeNull();
    expect(noteAt(scene, { x: 10, y: 10 })).toBeNull();
    const locked = board([note({ locked: true })]);
    expect(noteAt(locked.scene, { x: 110, y: 110 })).toBeNull();
  });

  it("lets ink go when dragged off its note, and join another", () => {
    const { scene } = board([
      note(),
      note({ id: id("other"), x: 400, y: 100 }),
      ink("i", 110, 110),
    ]);
    const stroke = scene.get(id("i")) as Shape;
    const moving = new Set([id("i")]);
    expect(reparentOnMove(scene, [stroke], moving, 20, 20).size).toBe(0);
    expect(reparentOnMove(scene, [stroke], moving, -200, 0).get(id("i"))).toMatchObject({
      parentId: null,
    });
    expect(reparentOnMove(scene, [stroke], moving, 300, 0).get(id("i"))).toMatchObject({
      parentId: "other",
    });
  });

  it("deletes and copies ink with its note", () => {
    const { scene, edit, doc } = board([note(), ink("i", 110, 110)]);
    edit((tx) => duplicate(scene, tx, [id("note")], 10));
    const copies = [...doc.all()].filter((s) => s.type === "freehand" && s.id !== "i");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.parentId).not.toBe("note");
    edit((tx) => remove(scene, tx, [id("note")]));
    expect([...doc.all()].filter((s) => s.id === "i" || s.id === "note")).toHaveLength(0);
  });

  it("places new ink on its note, on top", () => {
    const { scene } = board([note(), ink("i", 110, 110, { index: "a1" })]);
    const placed = placeOnNote(scene, ink("n", 120, 120), id("note"));
    expect(placed.parentId).toBe("note");
    expect(placed.index > "a1").toBe(true);
    expect(placeOnNote(scene, ink("n", 120, 120), null).parentId).toBeNull();
  });

  it("takes images that fit, and finds the note through what's on it", () => {
    const picture = (patch: Partial<Shape> = {}) =>
      box("pic", 120, 120, 50, 50, { type: "image", asset: "a".repeat(64), ...patch });
    const { scene } = board([note(), picture({ parentId: id("note"), index: "a1" })]);
    // Ink drawn over an image on a note is the note's.
    expect(noteAt(scene, { x: 140, y: 140 })).toBe("note");
    const pic = scene.get(id("pic")) as Shape;
    const moving = new Set([id("pic")]);
    expect(reparentOnMove(scene, [pic], moving, 10, 10).size).toBe(0);
    expect(reparentOnMove(scene, [pic], moving, 300, 0).get(id("pic"))).toMatchObject({
      parentId: null,
    });
    // An image bigger than the note dropped on it stays on the board.
    const loose = board([note(), picture({ w: 150 })]);
    expect(noteFor(loose.scene, loose.scene.get(id("pic")) as Shape)).toBeNull();
    expect(noteFor(loose.scene, { ...pic, parentId: null }, new Set([id("pic")]))).toBe("note");
    // Rectangles never join a note.
    expect(noteFor(loose.scene, { ...pic, type: "rectangle" })).toBeNull();
  });
});

describe("text formatting", () => {
  it("shares what every shape has, and only when every shape takes formatting", () => {
    const { scene } = board([
      box("a", 0, 0, 10, 10, { type: "sticky", bold: true, font: "serif" }),
      box("b", 20, 0, 10, 10, { type: "text", bold: true, color: "red" }),
      box("l", 40, 0, 10, 10, { type: "line" }),
    ]);
    const style = sharedTextStyle(scene, [id("a"), id("b")]);
    expect(style).toMatchObject({
      bold: true,
      italic: false,
      font: null,
      fontSize: "auto",
      align: null,
      valign: "middle",
      boxes: true,
    });
    expect(sharedTextStyle(scene, [id("b")])).toMatchObject({
      valign: null,
      boxes: false,
      textColor: "red",
    });
    expect(sharedTextStyle(scene, [id("a"), id("l")])).toBeNull();
  });

  it("writes a box's text color, and a text shape's color", () => {
    const note = box("a", 0, 0, 10, 10, { type: "sticky" });
    const text = box("b", 0, 0, 10, 10, { type: "text" });
    expect(textStylePatch(note, { textColor: "red", valign: "top" })).toEqual({
      textColor: "red",
      valign: "top",
    });
    expect(textStylePatch(text, { textColor: "red", valign: "top", bold: true })).toEqual({
      color: "red",
      bold: true,
    });
    expect(textStylePatch(text, { textColor: "auto" })).toEqual({});
  });
});
