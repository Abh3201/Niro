import { expect, type Locator, test } from "@playwright/test";

/** RGBA of the pixel at the center of the canvas's backing store. */
function centerPixel(canvas: Locator) {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    return Array.from(ctx.getImageData(el.width / 2, el.height / 2, 1, 1).data);
  });
}

test("draws the placeholder rectangle on a full-screen canvas", async ({ page }) => {
  await page.goto("/");
  const canvas = page.locator('[data-testid="board"] canvas');
  await expect(canvas).toHaveCount(1);

  // The engine draws on the next animation frame after mounting.
  await expect.poll(() => centerPixel(canvas)).toEqual([59, 130, 246, 255]); // #3b82f6

  const viewport = page.viewportSize();
  const box = await canvas.boundingBox();
  expect(box?.width).toBe(viewport?.width);
  expect(box?.height).toBe(viewport?.height);
});

test.describe("on a 2x screen", () => {
  test.use({ deviceScaleFactor: 2 });

  test("uses a backing store with twice the CSS pixels", async ({ page }) => {
    await page.goto("/");
    const canvas = page.locator('[data-testid="board"] canvas');
    await expect.poll(() => centerPixel(canvas)).toEqual([59, 130, 246, 255]);

    const size = await canvas.evaluate((el: HTMLCanvasElement) => ({
      backing: el.width,
      css: el.clientWidth,
    }));
    expect(size.backing).toBe(size.css * 2);
  });
});
