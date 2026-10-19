/**
 * The part of the canvas 2D API that `drawShape` and the engine's draw loop
 * use, writing SVG instead of pixels. Exporting through it means a shape is
 * drawn by one piece of code, so an SVG can't drift from what's on screen.
 *
 * Each element carries the transform current when it was drawn, and a clip
 * (`ctx.clip()`) opens a group that the matching `restore()` closes. Paths
 * are kept in the coordinates they were drawn in.
 */

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

interface State {
  matrix: Matrix;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: CanvasLineCap;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  /** Clip groups opened since this state was saved. */
  clips: number;
}

/** A path, as SVG path data. Stands in for `Path2D` when drawing into an `SvgContext`. */
export class SvgPath {
  d = "";

  moveTo(x: number, y: number): void {
    this.d += `M${n(x)} ${n(y)}`;
  }

  lineTo(x: number, y: number): void {
    this.d += `L${n(x)} ${n(y)}`;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.d += `Q${n(cx)} ${n(cy)} ${n(x)} ${n(y)}`;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.d += `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  }

  /** A whole ellipse: the only kind drawn. */
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number): void {
    const deg = n((rotation * 180) / Math.PI);
    const ax = rx * Math.cos(rotation);
    const ay = rx * Math.sin(rotation);
    this.d +=
      `M${n(x + ax)} ${n(y + ay)}` +
      `A${n(rx)} ${n(ry)} ${deg} 1 1 ${n(x - ax)} ${n(y - ay)}` +
      `A${n(rx)} ${n(ry)} ${deg} 1 1 ${n(x + ax)} ${n(y + ay)}Z`;
  }

  closePath(): void {
    this.d += "Z";
  }
}

export class SvgContext {
  private state: State = {
    matrix: IDENTITY,
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "butt",
    globalAlpha: 1,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    clips: 0,
  };
  private readonly saved: State[] = [];
  private path = new SvgPath();
  private readonly defs: string[] = [];
  private readonly body: string[] = [];

  get fillStyle(): string {
    return this.state.fillStyle;
  }
  set fillStyle(value: string) {
    this.state.fillStyle = value;
  }
  get strokeStyle(): string {
    return this.state.strokeStyle;
  }
  set strokeStyle(value: string) {
    this.state.strokeStyle = value;
  }
  get lineWidth(): number {
    return this.state.lineWidth;
  }
  set lineWidth(value: number) {
    this.state.lineWidth = value;
  }
  get lineCap(): CanvasLineCap {
    return this.state.lineCap;
  }
  set lineCap(value: CanvasLineCap) {
    this.state.lineCap = value;
  }
  get globalAlpha(): number {
    return this.state.globalAlpha;
  }
  set globalAlpha(value: number) {
    this.state.globalAlpha = value;
  }
  get font(): string {
    return this.state.font;
  }
  set font(value: string) {
    this.state.font = value;
  }
  get textAlign(): CanvasTextAlign {
    return this.state.textAlign;
  }
  set textAlign(value: CanvasTextAlign) {
    this.state.textAlign = value;
  }
  get textBaseline(): CanvasTextBaseline {
    return this.state.textBaseline;
  }
  set textBaseline(value: CanvasTextBaseline) {
    this.state.textBaseline = value;
  }

  save(): void {
    this.saved.push(this.state);
    this.state = { ...this.state, clips: 0 };
  }

  restore(): void {
    for (let i = 0; i < this.state.clips; i++) this.body.push("</g>");
    this.state = this.saved.pop() ?? this.state;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.state.matrix = [a, b, c, d, e, f];
  }

  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y);
  }

  rotate(angle: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.transform(cos, sin, -sin, cos, 0, 0);
  }

  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0);
  }

  beginPath(): void {
    this.path = new SvgPath();
  }

  moveTo(x: number, y: number): void {
    this.path.moveTo(x, y);
  }

  lineTo(x: number, y: number): void {
    this.path.lineTo(x, y);
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.path.quadraticCurveTo(cx, cy, x, y);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.path.rect(x, y, w, h);
  }

  ellipse(x: number, y: number, rx: number, ry: number, rotation: number): void {
    this.path.ellipse(x, y, rx, ry, rotation);
  }

  closePath(): void {
    this.path.closePath();
  }

  fill(path?: SvgPath): void {
    const d = (path ?? this.path).d;
    if (d) this.body.push(`<path d="${d}"${this.paint("fill")}${this.matrixAttr()}/>`);
  }

  stroke(): void {
    if (this.path.d)
      this.body.push(
        `<path d="${this.path.d}" fill="none"${this.paint("stroke")}${this.matrixAttr()}/>`,
      );
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.body.push(`<rect${this.box(x, y, w, h)}${this.paint("fill")}${this.matrixAttr()}/>`);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.body.push(
      `<rect${this.box(x, y, w, h)} fill="none"${this.paint("stroke")}${this.matrixAttr()}/>`,
    );
  }

  /** Clips what's drawn next to the current path, until the matching `restore`. */
  clip(): void {
    const id = `clip${this.defs.length}`;
    this.defs.push(
      `<clipPath id="${id}"><path d="${this.path.d}"${this.matrixAttr()}/></clipPath>`,
    );
    this.body.push(`<g clip-path="url(#${id})">`);
    this.state.clips++;
  }

  fillText(text: string, x: number, y: number): void {
    const anchor =
      this.state.textAlign === "center"
        ? "middle"
        : this.state.textAlign === "right" || this.state.textAlign === "end"
          ? "end"
          : "start";
    this.body.push(
      `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" style="font:${xml(this.state.font)};white-space:pre"${this.paint("fill")}${this.matrixAttr()}>${xml(text)}</text>`,
    );
  }

  /**
   * An image, embedded as a PNG data URL. Needs a DOM to encode it; without
   * one, the image is left out.
   */
  drawImage(image: CanvasImageSource, x: number, y: number, w: number, h: number): void {
    const href = dataUrl(image);
    if (href)
      this.body.push(
        `<image${this.box(x, y, w, h)} preserveAspectRatio="none" href="${xml(href)}"${this.matrixAttr()}/>`,
      );
  }

  /** The finished document, showing `box` (in drawing coordinates) at `width` × `height`. */
  toSvg(
    box: { x: number; y: number; w: number; h: number },
    width: number,
    height: number,
  ): string {
    // Close clips left open by a missing restore.
    while (this.saved.length > 0) this.restore();
    const defs = this.defs.length > 0 ? `<defs>${this.defs.join("")}</defs>` : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}">` +
      `${defs}${this.body.join("")}</svg>`
    );
  }

  private transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const [a0, b0, c0, d0, e0, f0] = this.state.matrix;
    this.state.matrix = [
      a0 * a + c0 * b,
      b0 * a + d0 * b,
      a0 * c + c0 * d,
      b0 * c + d0 * d,
      a0 * e + c0 * f + e0,
      b0 * e + d0 * f + f0,
    ];
  }

  private matrixAttr(): string {
    const m = this.state.matrix;
    return m.every((v, i) => v === IDENTITY[i]) ? "" : ` transform="matrix(${m.map(n).join(" ")})"`;
  }

  private paint(kind: "fill" | "stroke"): string {
    const { globalAlpha, strokeStyle, lineWidth, lineCap, fillStyle } = this.state;
    const alpha = globalAlpha < 1 ? ` opacity="${n(globalAlpha)}"` : "";
    if (kind === "fill") return ` fill="${xml(fillStyle)}"${alpha}`;
    const cap = lineCap === "butt" ? "" : ` stroke-linecap="${lineCap}"`;
    return ` stroke="${xml(strokeStyle)}" stroke-width="${n(lineWidth)}"${cap}${alpha}`;
  }

  private box(x: number, y: number, w: number, h: number): string {
    return ` x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`;
  }
}

/** A picture as a PNG data URL, or null where there's no canvas to encode it with. */
function dataUrl(image: CanvasImageSource): string | null {
  if (typeof document === "undefined") return null;
  const source = image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(Number(source.width) || 1));
  canvas.height = Math.max(1, Math.round(Number(source.height) || 1));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/** A number, short: SVG doesn't need 17 digits. */
function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** `text` for an XML attribute or element: markup escaped, and characters XML forbids dropped. */
function xml(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      // Half a surrogate pair, U+FFFE and U+FFFF are also not XML characters.
      .replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uFFFE\uFFFF]/g,
        "",
      )
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}
