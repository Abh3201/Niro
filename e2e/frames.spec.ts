import { expect, test } from "@playwright/test";
import {
  BLUE,
  drag,
  drawRectangle,
  expectPixel,
  expectStatus,
  openBoard,
  TRANSPARENT,
} from "./helpers";

const WHITE = [255, 255, 255, 255]; // a frame's surface, light theme

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

test("a frame carries what's drawn in it, and cuts it off at its edges", async ({ page }) => {
  await page.keyboard.press("f");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 400 });
  await expectStatus(page, 1, 1);
  await expectPixel(page, 350, 300, WHITE);

  await drawRectangle(page, { x: 250, y: 250 }, { x: 350, y: 350 });
  // Sticks out past the frame's right edge, which cuts it off.
  await drawRectangle(page, { x: 420, y: 250 }, { x: 560, y: 290 });
  await expectStatus(page, 3, 1);
  await expectPixel(page, 300, 300, BLUE);
  await expectPixel(page, 450, 270, BLUE);
  await expectPixel(page, 530, 270, TRANSPARENT);

  // Dragged by its name, just above it, the frame takes both along.
  await page.mouse.click(900, 650);
  await drag(page, { x: 230, y: 190 }, { x: 230, y: 290 });
  await expectStatus(page, 3, 1);
  await expectPixel(page, 300, 320, WHITE);
  await expectPixel(page, 300, 400, BLUE);
  await expectPixel(page, 450, 370, BLUE);
});

test("shapes grouped with Ctrl+G move together, and Ctrl+Shift+G takes them apart", async ({
  page,
}) => {
  await drawRectangle(page, { x: 200, y: 200 }, { x: 300, y: 300 });
  await drawRectangle(page, { x: 400, y: 200 }, { x: 500, y: 300 });
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+g");
  await expectStatus(page, 3, 1);
  await expect(page.getByTestId("ungroup")).toBeVisible();

  // Dragging either shape moves the group.
  await page.mouse.click(900, 650);
  await drag(page, { x: 250, y: 250 }, { x: 250, y: 450 });
  await expectPixel(page, 250, 450, BLUE);
  await expectPixel(page, 450, 450, BLUE);
  await expectPixel(page, 450, 250, TRANSPARENT);

  await page.keyboard.press("Control+Shift+g");
  await expectStatus(page, 2, 2);
  await expect(page.getByTestId("group")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expectStatus(page, 3, 2);
});
