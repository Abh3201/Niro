import { readFile } from "node:fs/promises";
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

test("long text stays inside its shape, while it's edited and after", async ({ page }) => {
  await drawRectangle(page, { x: 500, y: 200 }, { x: 740, y: 520 });
  await page.mouse.dblclick(620, 360);
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type(
    "This is brave ottergggyuyyuyygyuyuy yg huyyuytuuyyguygu ygu yg uy uy yu fuy uy yu uf uf u fu ftttttrtytttttyrryyrrtttttttgreghhggggttyytrttttttt",
  );
  // The editor wraps inside the shape.
  const box = await editor.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(500);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(740);
  await page.keyboard.press("Escape");
  await page.mouse.click(100, 650);
  const inside = { x: 505, y: 205, width: 230, height: 310 };
  await expect.poll(() => inkPixels(page, inside)).toBeGreaterThan(100);
  // Nothing drawn past the shape's edges.
  expect(await inkPixels(page, { x: 742, y: 200, width: 60, height: 320 }, "drawn")).toBe(0);
  expect(await inkPixels(page, { x: 440, y: 200, width: 58, height: 320 }, "drawn")).toBe(0);
});

test("formatting applies to a note's whole text, undoes, survives a reload and exports", async ({
  page,
}) => {
  await page.keyboard.press("n");
  await page.mouse.click(640, 360);
  await page.keyboard.type("Hello");
  await page.keyboard.press("Escape");
  await expectStatus(page, 1, 1);
  const top = { x: 550, y: 270, width: 180, height: 50 };
  const bottom = { x: 550, y: 400, width: 180, height: 50 };

  await page.getByTestId("text-valign-top").click();
  await expect.poll(() => inkPixels(page, top)).toBeGreaterThan(50);
  expect(await inkPixels(page, bottom)).toBe(0);

  // Red text isn't dark ink; undo brings the dark text back.
  await page.getByTestId("text-color-red").click();
  await expect.poll(() => inkPixels(page, top)).toBeLessThan(5);
  await page.keyboard.press("Control+z");
  await expect.poll(() => inkPixels(page, top)).toBeGreaterThan(50);

  // Ctrl + B while typing makes the whole note bold, and typing carries on.
  await page.keyboard.press("Enter");
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("text-bold")).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS("font-weight", "700");
  await page.keyboard.type("!");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expectStatus(page, 1, 0);

  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-svg").click(),
  ]);
  const svg = await readFile(await file.path(), "utf8");
  expect(svg).toContain("bold 100px");
  expect(svg).toContain("Hello!");

  await page.reload();
  await waitUntilLive(page);
  await page.mouse.click(700, 440);
  await expectStatus(page, 1, 1);
  await expect(page.getByTestId("text-bold")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("text-valign-top")).toHaveAttribute("aria-pressed", "true");
});
