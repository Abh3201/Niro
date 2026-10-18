import { type ColorName, indexesBetween, type Shape, type ShapeId } from "@niro/doc";
import { type PenPoint, strokeShape } from "./freehand";

/**
 * A seeded board for measuring performance: the same `seed` makes the
 * same shapes, so numbers from two runs (or two branches) compare.
 *
 * It's laid out like a busy workshop board: a grid of frames, each with a
 * wall of sticky notes (some grouped, some linked by arrows), a few labelled
 * boxes and pen scribbles, and loose notes, text and lines around them.
 * Shapes are as stored: inside a frame, positions are from its top-left.
 */
export function benchmarkBoard(count = 10_000, seed = 1): Shape[] {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const between = (min: number, max: number) => min + random() * (max - min);
  let serial = 0;
  const id = () => `bench-${seed}-${serial++}` as ShapeId;
  const phrase = (min: number, max: number) =>
    Array.from({ length: Math.round(between(min, max)) }, () => pick(WORDS)).join(" ");

  const base = (type: Shape["type"], parentId: ShapeId | null): Shape => ({
    id: id(),
    type,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    parentId,
    index: "a0",
    color: pick(COLORS),
    text: "",
    points: [],
    from: null,
    to: null,
  });

  const shapes: Shape[] = [];
  // Keys are given per parent at the end, in the order shapes were made.
  const add = (shape: Shape) => {
    shapes.push(shape);
    return shape;
  };

  const sticky = (parent: ShapeId | null, x: number, y: number) =>
    add({ ...base("sticky", parent), x, y, w: 200, h: 200, text: phrase(1, 12) });

  const scribble = (parent: ShapeId | null, cx: number, cy: number) => {
    const points: PenPoint[] = [];
    let x = cx;
    let y = cy;
    for (let i = 0; i < 40; i++) {
      x += between(-12, 14);
      y += between(-10, 10);
      points.push({ x, y, pressure: 0.5 });
    }
    return add({ ...base("freehand", parent), ...strokeShape(points), color: "black" });
  };

  const frameW = 2_300;
  const frameH = 1_420;
  const gap = 600;
  // Each frame: itself, 60 notes, 6 boxes, 8 scribbles, 10 arrows, 2 groups.
  const perFrame = 1 + 60 + 6 + 8 + 10 + 2;
  const frames = Math.min(100, Math.floor((count * 0.9) / perFrame));
  const columns = Math.ceil(Math.sqrt(frames));

  for (let f = 0; f < frames; f++) {
    const fx = (f % columns) * (frameW + gap);
    const fy = Math.floor(f / columns) * (frameH + gap);
    const frame = add({
      ...base("frame", null),
      x: fx,
      y: fy,
      w: frameW,
      h: frameH,
      color: "grey",
      text: `Workshop ${f + 1}: ${phrase(1, 3)}`,
    });
    const notes: Shape[] = [];
    for (let i = 0; i < 60; i++) {
      const col = i % 10;
      const row = Math.floor(i / 10);
      notes.push(
        sticky(frame.id, 60 + col * 220 + between(-8, 8), 60 + row * 220 + between(-8, 8)),
      );
    }
    // Two groups of three notes each.
    for (let g = 0; g < 2; g++) {
      const group = add({ ...base("group", frame.id) });
      for (const note of notes.slice(g * 20, g * 20 + 3)) {
        shapes[shapes.indexOf(note)] = { ...note, parentId: group.id };
      }
    }
    for (let i = 0; i < 6; i++) {
      add({
        ...base(i % 2 ? "ellipse" : "rectangle", frame.id),
        x: between(0, frameW - 300),
        y: between(0, frameH - 200),
        w: between(120, 300),
        h: between(80, 200),
        rotation: random() < 0.2 ? between(0, Math.PI * 2) : 0,
        text: phrase(0, 4),
      });
    }
    for (let i = 0; i < 8; i++)
      scribble(frame.id, between(100, frameW - 300), between(100, frameH - 200));
    for (let i = 0; i < 10; i++) {
      const from = pick(notes);
      const to = pick(notes);
      add({
        ...base("arrow", frame.id),
        x: from.x + 100,
        y: from.y + 100,
        w: to.x - from.x,
        h: to.y - from.y,
        color: "black",
        from: from.id,
        to: from.id === to.id ? null : to.id,
      });
    }
  }

  // Loose shapes around the frames, until the count is reached.
  const width = columns * (frameW + gap);
  const height = Math.ceil(frames / columns) * (frameH + gap) + 4_000;
  while (shapes.length < count) {
    const x = between(-2_000, width);
    const y = between(-2_000, height);
    const roll = random();
    if (roll < 0.6) sticky(null, x, y);
    else if (roll < 0.75)
      add({ ...base("text", null), x, y, w: 400, h: 34, color: "black", text: phrase(2, 6) });
    else if (roll < 0.9)
      add({ ...base("line", null), x, y, w: between(-400, 400), h: between(-400, 400) });
    else scribble(null, x, y);
  }

  return withIndexes(shapes);
}

/** Gives each parent's children increasing keys, in the order they were made. */
function withIndexes(shapes: Shape[]): Shape[] {
  const siblings = new Map<ShapeId | null, number[]>();
  shapes.forEach((shape, i) => {
    const list = siblings.get(shape.parentId) ?? [];
    list.push(i);
    siblings.set(shape.parentId, list);
  });
  const result = [...shapes];
  for (const list of siblings.values()) {
    const keys = indexesBetween(null, null, list.length);
    list.forEach((i, k) => {
      result[i] = { ...(result[i] as Shape), index: keys[k] as string };
    });
  }
  return result;
}

/** A small, fast seeded generator (Tommy Ettinger's Mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const COLORS: readonly ColorName[] = [
  "yellow",
  "yellow",
  "yellow",
  "blue",
  "green",
  "orange",
  "red",
  "violet",
];

const WORDS = [
  "user",
  "flow",
  "onboarding",
  "pricing",
  "idea",
  "risk",
  "launch",
  "survey",
  "metric",
  "churn",
  "mobile",
  "search",
  "feedback",
  "sprint",
  "blocker",
  "persona",
  "journey",
  "signup",
  "latency",
  "export",
  "share",
  "team",
  "goal",
  "why",
  "maybe",
  "fix",
  "test",
  "design",
  "copy",
  "review",
];
