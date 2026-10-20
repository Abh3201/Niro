import { expect, test } from "@playwright/test";
import { BLUE, drag, drawRectangle, expectPixel, openBoard } from "./helpers";

test("the minimap shows the board and moves the view when clicked", async ({ page }) => {
  await openBoard(page);
  await expect(page.getByTestId("minimap")).toHaveCount(0);

  await drawRectangle(page, { x: 300, y: 300 }, { x: 400, y: 380 });
  await expect(page.getByTestId("minimap")).toBeVisible();

  // Pan until the rectangle is far off screen.
  await page.keyboard.press("h");
  await drag(page, { x: 1000, y: 650 }, { x: 300, y: 100 });
  await drag(page, { x: 1000, y: 650 }, { x: 300, y: 100 });

  // Find the rectangle's blue on the minimap, and click there.
  const canvas = page.getByTestId("minimap-canvas");
  const blueCenter = () =>
    canvas.evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext("2d");
      if (!ctx) return null;
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs((data[i + 1] ?? 0) - 130) < 8 &&
          Math.abs((data[i + 2] ?? 0) - 246) < 8 &&
          (data[i + 3] ?? 0) > 200
        ) {
          n++;
          sx += (i / 4) % el.width;
          sy += Math.floor(i / 4 / el.width);
        }
      }
      const ratio = el.width / el.clientWidth;
      return n === 0 ? null : { x: sx / n / ratio, y: sy / n / ratio };
    });
  await expect.poll(blueCenter).not.toBeNull();
  const target = await blueCenter();
  if (!target) throw new Error("the rectangle isn't on the minimap");
  await canvas.click({ position: target });
  // The view is centered on the rectangle (640, 360 on screen).
  await expectPixel(page, 640, 360, BLUE);

  await page.getByTestId("minimap-hide").click();
  await expect(page.getByTestId("minimap")).toHaveCount(0);
  await page.getByTestId("minimap-show").click();
  await expect(page.getByTestId("minimap")).toBeVisible();
});
