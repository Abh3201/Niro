import { expect, type Page, test } from "@playwright/test";
import { drag, expectPixel, openBoard } from "./helpers";

// "Black" ink as the engine draws it (packages/engine/src/render.ts).
const INK_LIGHT = [30, 30, 36, 255]; // #1e1e24
const INK_DARK = [228, 228, 231, 255]; // #e4e4e7

const boardBackground = (page: Page) =>
  page.getByTestId("board").evaluate((el) => getComputedStyle(el).backgroundColor);
const storedTheme = (page: Page) => page.evaluate(() => localStorage.getItem("niro:theme"));

async function drawLine(page: Page): Promise<void> {
  await page.keyboard.press("l");
  await drag(page, { x: 500, y: 300 }, { x: 700, y: 300 });
}

test("the board switches between light and dark, and remembers the choice", async ({ page }) => {
  await openBoard(page);
  await drawLine(page);
  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expectPixel(page, 600, 300, INK_LIGHT);
  expect(await boardBackground(page)).toBe("rgb(247, 247, 248)");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectPixel(page, 600, 300, INK_DARK);
  expect(await boardBackground(page)).toBe("rgb(24, 24, 27)");
  expect(await storedTheme(page)).toBe("dark");

  // Applied before the page paints, not just once React has loaded.
  await page.reload({ waitUntil: "commit" });
  await page.waitForFunction(() => document.body !== null);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect(page.getByTestId("board")).toHaveAttribute("data-ready", "true");
  await expectPixel(page, 600, 300, INK_DARK);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectPixel(page, 600, 300, INK_LIGHT);
  expect(await storedTheme(page)).toBe("light");
});

test.describe("with a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("boards still start light", async ({ page }) => {
    await openBoard(page);
    await drawLine(page);
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expectPixel(page, 600, 300, INK_LIGHT);
    expect(await boardBackground(page)).toBe("rgb(247, 247, 248)");
    // The color swatches show colors as this theme draws them.
    await expect(page.getByTestId("color-black")).toHaveCSS("background-color", "rgb(30, 30, 36)");

    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectPixel(page, 600, 300, INK_DARK);
  });

  test("a saved dark choice is kept", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("niro:theme", "dark"));
    await openBoard(page);
    await drawLine(page);
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute("aria-pressed", "true");
    await expectPixel(page, 600, 300, INK_DARK);
  });
});

test("the page has the Niro icon", async ({ page, request }) => {
  await openBoard(page);
  const icons = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')
    .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  expect(icons).toHaveLength(4);
  for (const href of icons) {
    const response = await request.get(href);
    expect(response.ok(), href).toBe(true);
  }
});
