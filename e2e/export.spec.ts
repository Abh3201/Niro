import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { drawRectangle, expectStatus, openBoard, openMenu } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

async function download(page: Page, format: "png" | "svg") {
  await openMenu(page, "board-menu");
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(`export-${format}`).click(),
  ]);
  const path = await file.path();
  return { name: file.suggestedFilename(), data: await readFile(path) };
}

/** Loads `data` as an image in the page, as a browser would show it: its size, or null if it won't load. */
function imageSize(page: Page, data: Buffer, type: string) {
  return page.evaluate(
    async ({ base64, type }) => {
      const image = new Image();
      image.src = `data:${type};base64,${base64}`;
      try {
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      } catch {
        return null;
      }
    },
    { base64: data.toString("base64"), type },
  );
}

test("exports the board, or the selection, as PNG and SVG", async ({ page }) => {
  await openMenu(page, "board-menu");
  await expect(page.getByTestId("export-png")).toBeDisabled();
  await page.keyboard.press("Escape");
  // Two 100 × 100 rectangles, 200 apart.
  await drawRectangle(page, { x: 200, y: 200 }, { x: 300, y: 300 });
  await drawRectangle(page, { x: 500, y: 200 }, { x: 600, y: 300 });
  await page.keyboard.press("Escape");
  await expectStatus(page, 2, 0);

  // The whole board: 400 × 100, plus a 1-unit edge and 32 of margin a side.
  const png = await download(page, "png");
  expect(png.name).toBe("niro-board.png");
  expect(await imageSize(page, png.data, "image/png")).toEqual({ width: 932, height: 332 });

  const svg = await download(page, "svg");
  expect(svg.name).toBe("niro-board.svg");
  expect(await imageSize(page, svg.data, "image/svg+xml")).toEqual({ width: 466, height: 166 });

  // Just the selection.
  await page.mouse.click(250, 250);
  await expectStatus(page, 2, 1);
  const one = await download(page, "png");
  expect(one.name).toBe("niro-selection.png");
  expect(await imageSize(page, one.data, "image/png")).toEqual({ width: 332, height: 332 });
});
