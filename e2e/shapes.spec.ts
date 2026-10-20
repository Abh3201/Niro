import { expect, test } from "@playwright/test";
import {
  BLUE,
  drag,
  drawRectangle,
  expectPixel,
  expectStatus,
  openBoard,
  RED,
  STICKY_YELLOW,
  TRANSPARENT,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

test("drag out a rectangle; it is selected and the select tool comes back", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await expectPixel(page, 400, 275, BLUE);
  await expectPixel(page, 510, 275, TRANSPARENT);
  await expectStatus(page, 1, 1);
});

test("a click with the sticky tool drops a default sticky note", async ({ page }) => {
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(640, 360);
  // Default sticky is 200x200, centered on the click.
  await expectPixel(page, 640, 360, STICKY_YELLOW);
  await expectPixel(page, 545, 265, STICKY_YELLOW);
  await expectPixel(page, 640, 470, TRANSPARENT);
  await expectStatus(page, 1, 1);
});

test("drag a shape to move it", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await drag(page, { x: 400, y: 275 }, { x: 600, y: 375 });
  await expectPixel(page, 400, 275, TRANSPARENT);
  await expectPixel(page, 690, 440, BLUE);
  await expectStatus(page, 1, 1);
});

test("drag a corner handle to resize", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await drag(page, { x: 500, y: 350 }, { x: 600, y: 400 });
  await expectPixel(page, 590, 390, BLUE);
  await expectPixel(page, 310, 210, BLUE);
});

test("drag the rotation handle to rotate", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  // The handle sits 24px above the top center; dragging it to the right of
  // the center (400, 275) turns the shape 90° clockwise.
  await drag(page, { x: 400, y: 176 }, { x: 499, y: 275 });
  // Now 150 wide and 200 tall: x 325..475, y 175..375.
  await expectPixel(page, 400, 365, BLUE);
  await expectPixel(page, 310, 275, TRANSPARENT);
});

test("marquee selects every shape it touches; shift-click toggles", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 400, y: 300 });
  await drawRectangle(page, { x: 500, y: 200 }, { x: 600, y: 300 });
  await page.mouse.click(800, 600);
  await expectStatus(page, 2, 0);

  await drag(page, { x: 250, y: 150 }, { x: 550, y: 250 });
  await expectStatus(page, 2, 2);

  await page.keyboard.down("Shift");
  await page.mouse.click(350, 250);
  await page.keyboard.up("Shift");
  await expectStatus(page, 2, 1);
});

test("delete, undo and redo", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await page.keyboard.press("Delete");
  await expectPixel(page, 400, 275, TRANSPARENT);
  await expectStatus(page, 0, 0);

  await page.keyboard.press("ControlOrMeta+z");
  await expectPixel(page, 400, 275, BLUE);
  await page.getByTestId("redo").click();
  await expectPixel(page, 400, 275, TRANSPARENT);
  await page.getByTestId("undo").click();
  await page.getByTestId("undo").click();
  // Undoing the creation leaves nothing to undo.
  await expectPixel(page, 400, 275, TRANSPARENT);
  await expect(page.getByTestId("undo")).toBeDisabled();
});

test("color and z-order from the selection panel", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await drawRectangle(page, { x: 400, y: 250 }, { x: 600, y: 400 });
  await page.getByTestId("color-red").click();
  // The newer, red rectangle is on top where they overlap.
  await expectPixel(page, 450, 300, RED);

  await page.getByTestId("send-to-back").click();
  await expectPixel(page, 450, 300, BLUE);
  await expectPixel(page, 550, 380, RED);
});

test("duplicate with Ctrl+D", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await page.keyboard.press("ControlOrMeta+d");
  await expectStatus(page, 2, 1);
  // The copy is offset by 24px.
  await expectPixel(page, 515, 365, BLUE);
});

test("Escape cancels a drag and puts the shape back", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await page.mouse.move(400, 275);
  await page.mouse.down();
  await page.mouse.move(700, 500, { steps: 6 });
  await expectPixel(page, 400, 275, TRANSPARENT);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectPixel(page, 400, 275, BLUE);
});

test("the board is still there after a reload", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await expectPixel(page, 400, 275, BLUE);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId("board")).toHaveAttribute("data-ready", "true");
  await expectPixel(page, 400, 275, BLUE);
  await expectStatus(page, 1, 0);
});

test("a dragged shape snaps to another's edge, and Alt turns that off", async ({ page }) => {
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await drawRectangle(page, { x: 600, y: 450 }, { x: 700, y: 550 });
  // Dropped 3px short of lining up with the first one's left edge: it snaps.
  await drag(page, { x: 650, y: 500 }, { x: 353, y: 500 });
  await expectPixel(page, 301, 500, BLUE);

  await page.keyboard.down("Alt");
  await drag(page, { x: 350, y: 500 }, { x: 353, y: 500 });
  await page.keyboard.up("Alt");
  await expectPixel(page, 301, 500, TRANSPARENT);
});
