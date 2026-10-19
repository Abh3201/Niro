/**
 * Lab L6 benchmark: what each library costs in bytes shipped, bytes stored
 * and time spent, for a board shaped like Niro's.
 *
 * Run with `pnpm --filter @niro/lab-l6-yjs-vs-loro bench`. Numbers vary by
 * machine; compare the two columns, not the absolute values.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { LoroDoc, type LoroMap, type TreeID } from "loro-crdt";
import * as Y from "yjs";

const SHAPES = 10_000;
const DRAG_STEPS = 100_000;

interface Row {
  metric: string;
  yjs: string;
  loro: string;
}
const rows: Row[] = [];

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
const ms = (start: number) => `${(performance.now() - start).toFixed(0)} ms`;

function shapeProps(i: number) {
  return {
    type: "rectangle",
    x: (i % 100) * 300,
    y: Math.floor(i / 100) * 200,
    w: 240,
    h: 160,
    rotation: 0,
    parentId: null,
    index: `a${i.toString(36)}`,
    color: "#3b82f6",
  };
}

async function bundleSize(contents: string, resolveDir: string): Promise<number> {
  const result = await build({
    stdin: { contents, resolveDir, loader: "js" },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    write: false,
    // Loro's bundler entry imports its .wasm; measure the JS glue here and
    // the .wasm file separately below.
    loader: { ".wasm": "empty" },
    logLevel: "silent",
  });
  return gzipSync(result.outputFiles[0]?.contents ?? new Uint8Array()).byteLength;
}

async function bundles() {
  const here = dirname(new URL(import.meta.url).pathname);
  const yjs = await bundleSize(`import * as Y from "yjs"; globalThis.Y = Y;`, here);
  const loroJs = await bundleSize(`import * as L from "loro-crdt"; globalThis.L = L;`, here);
  const require = createRequire(import.meta.url);
  const loroDir = dirname(require.resolve("loro-crdt/package.json"));
  const wasm = readFileSync(join(loroDir, "bundler", "loro_wasm_bg.wasm"));
  rows.push({ metric: "Bundle, min+gzip (JS)", yjs: kb(yjs), loro: kb(loroJs) });
  rows.push({ metric: "Bundle, gzip (.wasm)", yjs: "none", loro: kb(gzipSync(wasm).byteLength) });
}

function yjsBoard() {
  const doc = new Y.Doc();
  let start = performance.now();
  const shapes = doc.getMap<Y.Map<unknown>>("shapes");
  doc.transact(() => {
    for (let i = 0; i < SHAPES; i++) {
      const shape = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(shapeProps(i))) shape.set(k, v);
      shapes.set(`s${i}`, shape);
    }
  });
  const create = ms(start);
  const fresh = Y.encodeStateAsUpdate(doc);

  start = performance.now();
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, fresh);
  // Materialize every shape, as the first render would.
  loaded.getMap("shapes").toJSON();
  const load = ms(start);

  // A long editing session: many small drags, each its own transaction, as
  // a pointermove handler would produce.
  start = performance.now();
  for (let step = 0; step < DRAG_STEPS; step++) {
    const shape = shapes.get(`s${step % 100}`);
    doc.transact(() => {
      shape?.set("x", step);
      shape?.set("y", step);
    });
  }
  const drags = ms(start);
  const afterDrags = Y.encodeStateAsUpdate(doc);
  return { create, load, drags, fresh: fresh.byteLength, afterDrags: afterDrags.byteLength };
}

function loroBoard() {
  const doc = new LoroDoc();
  let start = performance.now();
  const tree = doc.getTree("shapes");
  tree.enableFractionalIndex(0);
  const ids: TreeID[] = [];
  for (let i = 0; i < SHAPES; i++) {
    const node = tree.createNode();
    const { parentId: _parent, index: _index, ...props } = shapeProps(i);
    for (const [k, v] of Object.entries(props)) node.data.set(k, v);
    ids.push(node.id);
  }
  doc.commit();
  const create = ms(start);
  const fresh = doc.export({ mode: "snapshot" });

  start = performance.now();
  const loaded = new LoroDoc();
  loaded.import(fresh);
  // Materialize every shape, as the first render would. Loro decodes
  // lazily, so importing alone would understate the cost.
  loaded.getTree("shapes").toJSON();
  const load = ms(start);

  start = performance.now();
  for (let step = 0; step < DRAG_STEPS; step++) {
    const id = ids[step % 100];
    const data = id ? (tree.getNodeByID(id)?.data as LoroMap | undefined) : undefined;
    data?.set("x", step);
    data?.set("y", step);
    doc.commit();
  }
  const drags = ms(start);
  const afterDrags = doc.export({ mode: "snapshot" });
  const shallow = doc.export({ mode: "shallow-snapshot", frontiers: doc.frontiers() });
  return {
    create,
    load,
    drags,
    fresh: fresh.byteLength,
    afterDrags: afterDrags.byteLength,
    shallow: shallow.byteLength,
  };
}

await bundles();
const y = yjsBoard();
const l = loroBoard();
rows.push({ metric: `Create ${SHAPES} shapes`, yjs: y.create, loro: l.create });
rows.push({ metric: `Encoded board, ${SHAPES} shapes`, yjs: kb(y.fresh), loro: kb(l.fresh) });
rows.push({ metric: "Load encoded board", yjs: y.load, loro: l.load });
rows.push({ metric: `${DRAG_STEPS} drag transactions`, yjs: y.drags, loro: l.drags });
rows.push({
  metric: "Encoded board after drags",
  yjs: kb(y.afterDrags),
  loro: `${kb(l.afterDrags)} (shallow: ${kb(l.shallow)})`,
});

console.log(`Node ${process.version}, yjs vs loro-crdt\n`);
console.log("| Metric | Yjs | Loro |\n|---|---|---|");
for (const r of rows) console.log(`| ${r.metric} | ${r.yjs} | ${r.loro} |`);
