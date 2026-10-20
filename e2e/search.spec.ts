import { expect, test } from "@playwright/test";
import { openBoard } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

async function note(page: import("@playwright/test").Page, x: number, y: number, text: string) {
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(x, y);
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

test("Ctrl+F finds text on the board, counts the matches and steps through them", async ({
  page,
}) => {
  await note(page, 300, 250, "Launch plan");
  await note(page, 700, 250, "Budget");
  await note(page, 500, 520, "Launch party");

  await page.keyboard.press("Control+f");
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();
  await input.fill("launch");
  await expect(page.getByTestId("search-count")).toHaveText("1 of 2");
  await expect(page.getByTestId("selection-label")).toContainText("Launch plan");

  await input.press("Enter");
  await expect(page.getByTestId("search-count")).toHaveText("2 of 2");
  await expect(page.getByTestId("selection-label")).toContainText("Launch party");
  await input.press("Shift+Enter");
  await expect(page.getByTestId("search-count")).toHaveText("1 of 2");

  await input.fill("nothing like it");
  await expect(page.getByTestId("search-count")).toHaveText("No matches");

  await input.press("Escape");
  await expect(page.getByTestId("search")).toHaveCount(0);
});
