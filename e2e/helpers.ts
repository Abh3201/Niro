import { expect, type Locator, type Page } from "@playwright/test";

export const BLUE = [59, 130, 246, 255]; // #3b82f6, the placeholder rectangle
export const TRANSPARENT = [0, 0, 0, 0];

export function shapesLayer(page: Page): Locator {
  return page.locator('[data-testid="board"] canvas[data-layer="shapes"]');
}

/** RGBA of the shapes layer at a point given in CSS pixels. */
export function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  return shapesLayer(page).evaluate(
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

/** Waits until the engine has drawn its first frame. */
export async function waitForBoard(page: Page): Promise<void> {
  await page.goto("/");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  await expectPixel(page, viewport.width / 2, viewport.height / 2, BLUE);
}

/** Waits until the pixel at (x, y) has the given color. */
export async function expectPixel(page: Page, x: number, y: number, rgba: number[]) {
  await expect.poll(() => pixelAt(page, x, y)).toEqual(rgba);
}
