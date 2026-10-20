import { expect, test } from "@playwright/test";
import { BLUE, drawRectangle, expectPixel, expectStatus, openBoard, TRANSPARENT } from "./helpers";

test("a saved version can be looked at and restored after the shape is deleted", async ({
  page,
}) => {
  await openBoard(page);
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await expectStatus(page, 1, 1);

  await page.getByTestId("history-open").click();
  await expect(page.getByTestId("history-empty")).toBeVisible();
  await page.getByTestId("history-label").fill("With the box");
  await page.getByTestId("history-save").click();
  await expect(page.getByTestId("history-version")).toHaveText(/With the box/);
  // Saving selects it and draws it in the preview.
  await expect(page.getByTestId("history-preview")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("history-preview").locator("canvas").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("history")).toBeHidden();

  // Delete the box, then bring it back from the version.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expectStatus(page, 0, 0);
  await expectPixel(page, 400, 275, TRANSPARENT);

  await page.getByTestId("history-open").click();
  await page.getByTestId("history-version").filter({ hasText: "With the box" }).click();
  await expect(page.getByTestId("history-preview")).toHaveAttribute("data-state", "ready");
  await page.getByTestId("history-restore").click();
  await expect(page.getByTestId("history")).toBeHidden();
  await expectStatus(page, 1, 0);
  await expectPixel(page, 400, 275, BLUE);

  // It was a normal edit: undo takes it away again.
  await page.mouse.click(900, 600);
  await page.keyboard.press("ControlOrMeta+z");
  await expectStatus(page, 0, 0);
  await expectPixel(page, 400, 275, TRANSPARENT);
});

test("someone with a view link can look at versions but not save or restore", async ({
  page,
  browser,
}) => {
  await openBoard(page);
  await drawRectangle(page, { x: 300, y: 200 }, { x: 500, y: 350 });
  await page.getByTestId("history-open").click();
  await page.getByTestId("history-save").click();
  await expect(page.getByTestId("history-version")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // A second browser opens the board with the view key.
  const viewKey = await page.evaluate(() => {
    const id = location.pathname.split("/").pop() ?? "";
    return JSON.parse(localStorage.getItem(`niro:keys:${id}`) ?? "{}").view as string | undefined;
  });
  expect(viewKey).toBeTruthy();
  const viewer = await browser.newPage();
  await viewer.goto(`${page.url().split("#")[0]}#k=${viewKey}`);
  await expect(viewer.getByTestId("board")).toHaveAttribute("data-ready", "true");
  await viewer.getByTestId("history-open").click();
  await expect(viewer.getByTestId("history-version")).toHaveCount(1);
  await expect(viewer.getByTestId("history-save")).toHaveCount(0);
  await viewer.getByTestId("history-version").click();
  await expect(viewer.getByTestId("history-restore")).toBeDisabled();
  await viewer.close();
});
