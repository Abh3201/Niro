import { test } from "@playwright/test";
import { BLUE, drawRectangle, expectPixel, expectStatus, openBoard, TRANSPARENT } from "./helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("copy, paste under the pointer, cut", async ({ page }) => {
  await openBoard(page);
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await page.keyboard.press("ControlOrMeta+c");
  await page.mouse.move(900, 500);
  await page.keyboard.press("ControlOrMeta+v");
  await expectStatus(page, 2, 1);
  // Centered where the pointer is; the original stays.
  await expectPixel(page, 900, 500, BLUE);
  await expectPixel(page, 400, 275, BLUE);

  // Cut takes the pasted one away, and a paste brings it back elsewhere.
  await page.keyboard.press("ControlOrMeta+x");
  await expectStatus(page, 1, 0);
  await expectPixel(page, 900, 500, TRANSPARENT);
  await page.mouse.move(700, 600);
  await page.keyboard.press("ControlOrMeta+v");
  await expectPixel(page, 700, 600, BLUE);
});

test("shapes paste into another board in another tab", async ({ page, context }) => {
  await openBoard(page);
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await page.keyboard.press("ControlOrMeta+c");

  const other = await context.newPage();
  await openBoard(other);
  await other.mouse.move(640, 360);
  await other.keyboard.press("ControlOrMeta+v");
  await expectStatus(other, 1, 1);
  await expectPixel(other, 640, 360, BLUE);
});

test("plain text pastes as a text shape", async ({ page }) => {
  await openBoard(page);
  await page.evaluate(() => navigator.clipboard.writeText("hello board"));
  await page.mouse.move(640, 360);
  await page.keyboard.press("ControlOrMeta+v");
  await expectStatus(page, 1, 1);
});
