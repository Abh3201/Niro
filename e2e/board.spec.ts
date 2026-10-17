import { expect, test } from "@playwright/test";
import { BLUE, drawRectangle, expectPixel, openBoard, shapesLayer } from "./helpers";

test("the home page opens a new board with full-screen canvas layers", async ({ page }) => {
  await openBoard(page);
  const firstBoard = page.url();

  await expect(page.locator('[data-testid="board"] canvas')).toHaveCount(3);
  const viewport = page.viewportSize();
  const box = await shapesLayer(page).boundingBox();
  expect(box?.width).toBe(viewport?.width);
  expect(box?.height).toBe(viewport?.height);

  await openBoard(page);
  expect(page.url()).not.toBe(firstBoard);
});

test("a mistyped board link is a 404", async ({ page }) => {
  const response = await page.goto("/b/no!");
  expect(response?.status()).toBe(404);
});

test.describe("on a 2x screen", () => {
  test.use({ deviceScaleFactor: 2 });

  test("uses a backing store with twice the CSS pixels", async ({ page }) => {
    await openBoard(page);
    const size = await shapesLayer(page).evaluate((el: HTMLCanvasElement) => ({
      backing: el.width,
      css: el.clientWidth,
    }));
    expect(size.backing).toBe(size.css * 2);
    await drawRectangle(page, { x: 600, y: 320 }, { x: 680, y: 400 });
    await expectPixel(page, 640, 360, BLUE);
  });
});
