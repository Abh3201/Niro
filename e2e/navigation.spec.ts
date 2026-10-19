import { expect, type Page, test } from "@playwright/test";
import { BLUE, drag, drawRectangle, expectPixel, openBoard, TRANSPARENT } from "./helpers";

// Desktop Chrome viewport is 1280x720. Each test starts with a 240x160
// rectangle from screen (520, 280) to (760, 440), centered on the world origin.
async function boardWithRectangle(page: Page) {
  await openBoard(page);
  await drawRectangle(page, { x: 520, y: 280 }, { x: 760, y: 440 });
  await expectPixel(page, 640, 360, BLUE);
}

test("ctrl + wheel zooms around the cursor", async ({ page }) => {
  await boardWithRectangle(page);
  await expectPixel(page, 770, 360, TRANSPARENT);

  // 10px inside the rectangle's right edge.
  await page.mouse.move(750, 360);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");

  await expect(page.getByTestId("zoom-level")).toHaveText("272%");
  // The point under the cursor stayed put, so the edge moved out to ~777px.
  await expectPixel(page, 750, 360, BLUE);
  await expectPixel(page, 770, 360, BLUE);
  await expectPixel(page, 790, 360, TRANSPARENT);
});

test("plain wheel and trackpad scroll pan instead of zooming", async ({ page }) => {
  await boardWithRectangle(page);
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, 200);

  await expect(page.getByTestId("zoom-level")).toHaveText("100%");
  // Content moved up by 200px: the rectangle now spans y 80..240.
  await expectPixel(page, 640, 230, BLUE);
  await expectPixel(page, 640, 300, TRANSPARENT);
});

test("the hand tool, space + drag and middle-drag pan the board", async ({ page }) => {
  await boardWithRectangle(page);

  await page.keyboard.press("h");
  await drag(page, { x: 640, y: 360 }, { x: 740, y: 410 });
  // Moved by (100, 50): now spans x 620..860, y 330..490.
  await expectPixel(page, 850, 480, BLUE);
  await expectPixel(page, 530, 290, TRANSPARENT);

  await page.keyboard.press("v");
  await page.keyboard.down("Space");
  await drag(page, { x: 100, y: 100 }, { x: 0, y: 100 });
  await page.keyboard.up("Space");
  // Moved back left by 100: x 520..760.
  await expectPixel(page, 530, 480, BLUE);
  await expectPixel(page, 770, 480, TRANSPARENT);

  await page.mouse.move(100, 100);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(100, 50, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  // Moved up by 50: y 280..440 again.
  await expectPixel(page, 640, 430, BLUE);
  await expectPixel(page, 640, 450, TRANSPARENT);
  // None of that moved the shape itself.
  await expect(page.getByTestId("board-status")).toHaveText("1 shape, 1 selected");
});

test("keyboard shortcuts and buttons step through zoom levels", async ({ page }) => {
  await boardWithRectangle(page);
  const level = page.getByTestId("zoom-level");

  await page.keyboard.press("Control+Equal");
  await expect(level).toHaveText("125%");
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Control+Minus");
  await expect(level).toHaveText("75%");
  await page.keyboard.press("Control+Digit0");
  await expect(level).toHaveText("100%");

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).toHaveText("125%");
  await level.click();
  await expect(level).toHaveText("100%");
});

test("does no work while idle", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    (window as unknown as { rafCalls: number }).rafCalls = 0;
    window.requestAnimationFrame = (callback) => {
      (window as unknown as { rafCalls: number }).rafCalls++;
      return original(callback);
    };
  });
  await boardWithRectangle(page);
  await page.waitForTimeout(300);

  const count = () => page.evaluate(() => (window as unknown as { rafCalls: number }).rafCalls);
  const before = await count();
  await page.waitForTimeout(1000);
  expect(await count()).toBe(before);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("two fingers pinch-zoom around their midpoint, even starting on a shape", async ({
    page,
  }) => {
    await boardWithRectangle(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: Array<[number, number]>,
    ) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([x, y], id) => ({ x, y, id })),
      });

    await touch("touchStart", [
      [590, 360],
      [690, 360],
    ]);
    for (let step = 1; step <= 5; step++) {
      const half = 50 + step * 10; // spread grows from 100 to 200
      await touch("touchMove", [
        [640 - half, 360],
        [640 + half, 360],
      ]);
    }
    await touch("touchEnd", []);

    await expect(page.getByTestId("zoom-level")).toHaveText("200%");
    // Zoomed 2x around the center: the rectangle now spans x 400..880.
    await expectPixel(page, 870, 360, BLUE);
    await expectPixel(page, 890, 360, TRANSPARENT);
  });
});
