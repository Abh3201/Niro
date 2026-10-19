import { expect, type Locator, type Page } from "@playwright/test";

// Shape colors as the engine draws them (packages/engine/src/render.ts, light theme).
export const BLUE = [59, 130, 246, 255]; // rectangle default, #3b82f6
export const RED = [239, 68, 68, 255]; // #ef4444
export const STICKY_YELLOW = [254, 240, 138, 255]; // sticky paper, #fef08a
export const TRANSPARENT = [0, 0, 0, 0];

export interface At {
  x: number;
  y: number;
}

export function shapesLayer(page: Page): Locator {
  return layer(page, "shapes");
}

function layer(page: Page, name: "shapes" | "overlay"): Locator {
  return page.locator(`[data-testid="board"] canvas[data-layer="${name}"]`);
}

/** RGBA of the shapes layer at a point given in CSS pixels. */
export function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  return layerPixelAt(page, "shapes", x, y);
}

/** RGBA of one canvas layer at a point given in CSS pixels. */
export function layerPixelAt(
  page: Page,
  name: "shapes" | "overlay",
  x: number,
  y: number,
): Promise<number[]> {
  return layer(page, name).evaluate(
    (el: HTMLCanvasElement, [cssX, cssY]) => {
      const ctx = el.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const ratio = el.width / el.clientWidth;
      return Array.from(
        ctx.getImageData(Math.round(cssX * ratio), Math.round(cssY * ratio), 1, 1).data,
      );
    },
    [x, y] as const,
  );
}

/** Waits until the pixel at (x, y) has the given color. */
export async function expectPixel(page: Page, x: number, y: number, rgba: number[]) {
  await expect.poll(() => pixelAt(page, x, y)).toEqual(rgba);
}

/** Opens a new, empty board as its editor and waits until it's running and live. */
export async function openBoard(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/b\/[A-Za-z0-9_-]+#k=e\.[A-Za-z0-9_-]{22}$/);
  await waitUntilLive(page);
}

/** Waits until the engine is running and connected to the realtime server. */
export async function waitUntilLive(page: Page): Promise<void> {
  await expect(page.getByTestId("board")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("sync-status")).toHaveText("Live");
}

export async function drag(page: Page, from: At, to: At, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** Draws a rectangle with the rectangle tool. It ends up selected, with the select tool active. */
export async function drawRectangle(page: Page, from: At, to: At): Promise<void> {
  await page.keyboard.press("r");
  await drag(page, from, to);
  await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
}

export async function expectStatus(page: Page, shapes: number, selected: number): Promise<void> {
  await expect(page.getByTestId("board-status")).toHaveText(
    `${shapes} ${shapes === 1 ? "shape" : "shapes"}, ${selected} selected`,
  );
}
