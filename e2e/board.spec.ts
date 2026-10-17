import { expect, test } from "@playwright/test";
import { BLUE, pixelAt, shapesLayer, waitForBoard } from "./helpers";

test("draws the placeholder on full-screen canvas layers", async ({ page }) => {
  await waitForBoard(page);

  await expect(page.locator('[data-testid="board"] canvas')).toHaveCount(3);
  const viewport = page.viewportSize();
  const box = await shapesLayer(page).boundingBox();
  expect(box?.width).toBe(viewport?.width);
  expect(box?.height).toBe(viewport?.height);
});

test.describe("on a 2x screen", () => {
  test.use({ deviceScaleFactor: 2 });

  test("uses a backing store with twice the CSS pixels", async ({ page }) => {
    await waitForBoard(page);
    const size = await shapesLayer(page).evaluate((el: HTMLCanvasElement) => ({
      backing: el.width,
      css: el.clientWidth,
    }));
    expect(size.backing).toBe(size.css * 2);
    expect(await pixelAt(page, 640, 360)).toEqual(BLUE);
  });
});
