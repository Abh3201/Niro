import { type Browser, expect, test } from "@playwright/test";
import { BLUE, drag, drawRectangle, expectPixel, openBoard, waitUntilLive } from "./helpers";

async function person(browser: Browser, identity?: { name: string; color: string }) {
  const context = await browser.newContext();
  if (identity) {
    await context.addInitScript((value) => {
      localStorage.setItem("niro:identity", value);
    }, JSON.stringify(identity));
  }
  return { context, page: await context.newPage() };
}

test("presenting steps through the frames, and others can follow along", async ({ browser }) => {
  const alice = await person(browser, { name: "Alice Author", color: "#0369a1" });
  const bob = await person(browser);
  const { page } = alice;
  await openBoard(page);

  // Two frames: the second, off to the right and down, has a blue box at its center.
  await expect(page.getByTestId("present-start")).toBeDisabled();
  await page.keyboard.press("f");
  await drag(page, { x: 150, y: 150 }, { x: 450, y: 350 });
  await page.keyboard.press("f");
  await drag(page, { x: 900, y: 500 }, { x: 1200, y: 650 });
  await drawRectangle(page, { x: 1000, y: 545 }, { x: 1100, y: 605 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("present-start")).toBeEnabled();

  await page.getByTestId("board").click({ position: { x: 700, y: 100 } });
  await page.getByTestId("present-start").click();
  await expect(page.getByTestId("present-count")).toHaveText("Slide 1 of 2");
  await expect(page.getByTestId("tool-select")).toHaveCount(0);

  // Bob joins and is offered the presentation.
  await bob.page.goto(page.url());
  await waitUntilLive(bob.page);
  await expect(bob.page.getByTestId("presenter-banner")).toContainText(
    "Alice Author is presenting",
  );

  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("present-count")).toHaveText("Slide 2 of 2");
  await expectPixel(page, 640, 360, BLUE);

  await bob.page.getByTestId("follow-presenter").click();
  await expect(bob.page.getByTestId("following")).toHaveText(/Following Alice Author/);
  await expectPixel(bob.page, 640, 360, BLUE);

  // Back a slide with the keyboard, then stop with Esc.
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("present-count")).toHaveText("Slide 1 of 2");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("present-count")).toHaveCount(0);
  await expect(page.getByTestId("tool-select")).toBeVisible();
  await expect(bob.page.getByTestId("presenter-banner")).toHaveCount(0);

  await alice.context.close();
  await bob.context.close();
});
