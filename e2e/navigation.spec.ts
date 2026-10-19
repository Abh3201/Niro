import { expect, test } from "@playwright/test";
import { BLUE, expectPixel, TRANSPARENT, waitForBoard } from "./helpers";

// Desktop Chrome viewport is 1280x720, so the 240x160 placeholder at the world
// origin starts at screen (520, 280) to (760, 440).

test("ctrl + wheel zooms around the cursor", async ({ page }) => {
  await waitForBoard(page);
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
  await waitForBoard(page);
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, 200);

  await expect(page.getByTestId("zoom-level")).toHaveText("100%");
  // Content moved up by 200px: the rectangle now spans y 80..240.
  await expectPixel(page, 640, 230, BLUE);
  await expectPixel(page, 640, 300, TRANSPARENT);
});

test("dragging pans the board", async ({ page }) => {
  await waitForBoard(page);
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(740, 410, { steps: 5 });
  await page.mouse.up();

  // Moved by (100, 50): now spans x 620..860, y 330..490.
  await expectPixel(page, 850, 480, BLUE);
  await expectPixel(page, 530, 290, TRANSPARENT);
});

test("keyboard shortcuts and buttons step through zoom levels", async ({ page }) => {
  await waitForBoard(page);
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
  await waitForBoard(page);
  await page.waitForTimeout(300);

  const count = () => page.evaluate(() => (window as unknown as { rafCalls: number }).rafCalls);
  const before = await count();
  await page.waitForTimeout(1000);
  expect(await count()).toBe(before);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("two fingers pinch-zoom around their midpoint", async ({ page }) => {
    await waitForBoard(page);
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
