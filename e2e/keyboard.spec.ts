import { expect, test } from "@playwright/test";
import { drawRectangle, expectStatus, openBoard } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

test("Tab steps through shapes in reading order, then lets focus go", async ({ page }) => {
  await drawRectangle(page, { x: 400, y: 200 }, { x: 500, y: 300 });
  await page.keyboard.press("o");
  await page.mouse.move(150, 200);
  await page.mouse.down();
  await page.mouse.move(250, 300, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await expectStatus(page, 2, 0);
  const label = page.getByTestId("selection-label");
  const board = page.getByTestId("board");

  // Left to right: the ellipse first, though it was drawn second.
  await page.keyboard.press("Tab");
  await expectStatus(page, 2, 1);
  await expect(label).toHaveText("Ellipse, green");
  await expect(board).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(label).toHaveText("Rectangle, blue");
  await page.keyboard.press("Shift+Tab");
  await expect(label).toHaveText("Ellipse, green");

  // Past the last shape, focus moves on to the rest of the page.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expectStatus(page, 2, 0);
  await expect(board).not.toBeFocused();

  // A screen reader can read the shapes next to the board.
  await expect(page.getByTestId("shape-list").getByRole("listitem")).toHaveText([
    "Ellipse, green",
    "Rectangle, blue",
  ]);
});

test("? lists the shortcuts, and keys in the list don't reach the board", async ({ page }) => {
  await drawRectangle(page, { x: 400, y: 200 }, { x: 500, y: 300 });
  await expectStatus(page, 1, 1);
  const help = page.getByTestId("shortcuts");

  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expectStatus(page, 1, 1);

  await page.getByTestId("shortcuts-button").click();
  await expect(help).toBeVisible();
  await help.getByRole("button", { name: "Close" }).click();
  await expect(help).toBeHidden();
});
