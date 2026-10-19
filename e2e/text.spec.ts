import { expect, test } from "@playwright/test";
import { drawRectangle, expectStatus, inkPixels, openBoard, waitUntilLive } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

// A default sticky note dropped at (640, 360) covers this box.
const STICKY = { x: 545, y: 265, width: 190, height: 190 };

test("type on a new sticky note; the text is drawn and kept", async ({ page }) => {
  await page.keyboard.press("n");
  await page.mouse.click(640, 360);
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type("Hello Niro");
  await expect(editor).toHaveValue("Hello Niro");
  // While it's being edited, the editor shows the text and the canvas doesn't.
  expect(await inkPixels(page, STICKY)).toBe(0);

  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect.poll(() => inkPixels(page, STICKY)).toBeGreaterThan(50);
  await expectStatus(page, 1, 1);

  await page.reload();
  await waitUntilLive(page);
  await expect.poll(() => inkPixels(page, STICKY)).toBeGreaterThan(50);
});

test("the text tool writes text where it clicks; with nothing typed it leaves nothing", async ({
  page,
}) => {
  await page.keyboard.press("t");
  await page.mouse.click(300, 200);
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeFocused();
  await expectStatus(page, 0, 0);
  await page.keyboard.type("A line of text");
  await expectStatus(page, 1, 1);
  await page.keyboard.press("Escape");
  const line = { x: 295, y: 185, width: 245, height: 30 };
  await expect.poll(() => inkPixels(page, line, "drawn")).toBeGreaterThan(50);

  await page.keyboard.press("t");
  await page.mouse.click(300, 500);
  await expect(editor).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expectStatus(page, 1, 0);
});

test("double-click a shape to write in it; Enter edits again; undo takes the text back", async ({
  page,
}) => {
  await drawRectangle(page, { x: 440, y: 260 }, { x: 840, y: 460 });
  const inside = { x: 450, y: 270, width: 380, height: 180 };
  await page.mouse.dblclick(640, 360);
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type("ok");
  await page.keyboard.press("Escape");
  await expect.poll(() => inkPixels(page, inside)).toBeGreaterThan(20);

  await page.keyboard.press("Enter");
  await expect(editor).toHaveValue("ok");
  await page.keyboard.type("!");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toHaveValue("ok");
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => inkPixels(page, inside)).toBe(0);
  await expectStatus(page, 1, 1);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a new sticky note takes typing, and a double tap edits it again", async ({ page }) => {
    await page.getByTestId("tool-sticky").tap();
    await page.touchscreen.tap(640, 360);
    const editor = page.getByTestId("text-editor");
    await expect(editor).toBeFocused();
    await page.keyboard.type("tapped");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);

    await page.touchscreen.tap(640, 360);
    await page.touchscreen.tap(640, 360);
    await expect(editor).toHaveValue("tapped");
  });
});
