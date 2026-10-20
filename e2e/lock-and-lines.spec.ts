import { expect, test } from "@playwright/test";
import {
  BLUE,
  drag,
  drawRectangle,
  expectPixel,
  expectStatus,
  openBoard,
  pixelAt,
  TRANSPARENT,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

test("a locked shape can't be moved or deleted until it is unlocked", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await page.getByTestId("lock").click();
  await expect(page.getByTestId("unlock")).toBeVisible();

  // Dragging it, deleting it and selecting all do nothing to it.
  await drag(page, { x: 400, y: 275 }, { x: 600, y: 400 });
  await expectPixel(page, 400, 275, BLUE);
  await page.keyboard.press("Delete");
  await expectStatus(page, 1, 0);
  await expectPixel(page, 400, 275, BLUE);
  await page.keyboard.press("ControlOrMeta+a");
  await expectStatus(page, 1, 0);

  // Click it, unlock with the keyboard shortcut, and it moves.
  await page.mouse.click(400, 275);
  await expectStatus(page, 1, 1);
  await page.keyboard.press("Shift+Alt+l");
  await expect(page.getByTestId("lock")).toBeVisible();
  await drag(page, { x: 400, y: 275 }, { x: 600, y: 400 });
  await expectPixel(page, 400, 275, TRANSPARENT);
  await expectPixel(page, 600, 400, BLUE);
});

test("lines can be dashed, thicker, and given arrowheads", async ({ page }) => {
  await page.keyboard.press("l");
  await drag(page, { x: 300, y: 300 }, { x: 700, y: 300 });
  await expect(page.getByTestId("dash-solid")).toHaveAttribute("aria-pressed", "true");
  expect((await pixelAt(page, 317, 300))[3]).toBe(255);

  await page.getByTestId("dash-dashed").click();
  await expect(page.getByTestId("dash-dashed")).toHaveAttribute("aria-pressed", "true");
  // Dashes are 12 long with 10 between, starting at the line's start.
  await expect.poll(async () => (await pixelAt(page, 317, 300))[3]).toBe(0);
  await expect.poll(async () => (await pixelAt(page, 305, 300))[3]).toBe(255);

  // Thick lines cover more rows.
  expect((await pixelAt(page, 305, 303))[3]).toBe(0);
  await page.getByTestId("thickness-thick").click();
  await expect.poll(async () => (await pixelAt(page, 305, 303))[3]).toBe(255);

  // A head at the end: ink right at the tip, none before the start.
  await page.getByTestId("dash-solid").click();
  await page.getByTestId("head-both").click();
  await expect(page.getByTestId("head-both")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await pixelAt(page, 700 - 20, 306))[3]).toBe(255);
});
