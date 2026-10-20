import { expect, test } from "@playwright/test";
import { expectStatus, openBoard } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

test("the comments and board menus open on hover or click and close again", async ({ page }) => {
  const comments = page.getByTestId("comments-menu");
  // Hovering shows the menu; moving away hides it.
  await comments.hover();
  await expect(comments).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("comment-add")).toBeVisible();
  await page.mouse.move(700, 400);
  await expect(comments).toHaveAttribute("aria-expanded", "false");

  // A click keeps it open when the pointer leaves; Escape closes it.
  await comments.click();
  await page.mouse.move(700, 400);
  await page.waitForTimeout(400);
  await expect(page.getByTestId("comments-open")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(comments).toHaveAttribute("aria-expanded", "false");
  await expect(comments).toBeFocused();

  // An item does its work and closes the menu.
  await comments.click();
  await page.getByTestId("comments-open").click();
  await expect(page.getByTestId("comment-list")).toBeVisible();
  await expect(comments).toHaveAttribute("aria-expanded", "false");
  await expect(comments).toHaveClass(/active/);

  // The board menu, bottom right, closes on a click elsewhere.
  const board = page.getByTestId("board-menu");
  await board.click();
  await expect(page.getByTestId("history-open")).toBeVisible();
  await page.getByTestId("board").click({ position: { x: 700, y: 300 } });
  await expect(board).toHaveAttribute("aria-expanded", "false");
});

test("the text bar shows the first time, then folds away until opened", async ({ page }) => {
  await page.keyboard.press("n");
  await page.mouse.click(640, 360);
  await page.keyboard.press("Escape");
  await expectStatus(page, 1, 1);
  const toggle = page.getByTestId("text-format-toggle");
  await expect(page.getByTestId("text-font")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // After the first time it starts folded.
  await page.keyboard.press("Escape");
  await expectStatus(page, 1, 0);
  await page.mouse.click(640, 360);
  await expectStatus(page, 1, 1);
  await expect(page.getByTestId("text-font")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Opening it keeps it open, across a reload too.
  await toggle.click();
  await expect(page.getByTestId("text-font")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("board")).toHaveAttribute("data-ready", "true");
  await page.mouse.click(640, 360);
  await expectStatus(page, 1, 1);
  await expect(page.getByTestId("text-font")).toBeVisible();
});
