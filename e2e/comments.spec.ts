import { type Browser, expect, test } from "@playwright/test";
import { drag, drawRectangle, openBoard, openMenu, waitUntilLive } from "./helpers";

async function person(browser: Browser, name: string) {
  const context = await browser.newContext();
  await context.addInitScript(
    (value) => {
      localStorage.setItem("niro:identity", value);
    },
    JSON.stringify({ name, color: "#b91c1c" }),
  );
  return { context, page: await context.newPage() };
}

test("a comment pinned on a shape follows it, and others reply and resolve it", async ({
  browser,
}) => {
  const alice = await person(browser, "Alice Ant");
  const bob = await person(browser, "Bob Bee");
  await openBoard(alice.page);
  await drawRectangle(alice.page, { x: 300, y: 200 }, { x: 500, y: 350 });

  // C, then a click on the shape: a box for the first message.
  await alice.page.keyboard.press("c");
  await expect(alice.page.getByTestId("comments-menu")).toHaveClass(/active/);
  await alice.page.mouse.click(400, 275);
  await alice.page.getByTestId("comment-text").fill("Why this color?");
  await alice.page.getByTestId("comment-send").click();
  const pin = alice.page.getByTestId("comment-pin");
  await expect(pin).toHaveCount(1);
  await expect(alice.page.getByTestId("comment-message")).toContainText("Why this color?");
  await expect(alice.page.getByTestId("comments-menu")).not.toHaveClass(/active/);

  // Move the shape: the pin goes with it.
  await alice.page.getByRole("button", { name: "Close", exact: true }).click();
  const before = await pin.boundingBox();
  await drag(alice.page, { x: 320, y: 220 }, { x: 520, y: 220 });
  await expect
    .poll(async () => ((await pin.boundingBox())?.x ?? 0) - (before?.x ?? 0))
    .toBeGreaterThan(150);

  // Bob sees it, as new, opens it and replies.
  await bob.page.goto(alice.page.url());
  await waitUntilLive(bob.page);
  const bobPin = bob.page.getByTestId("comment-pin");
  await expect(bobPin).toHaveCount(1);
  await expect(bobPin).toHaveAttribute("data-unread", "true");
  await bobPin.click();
  await expect(bob.page.getByTestId("comment-message")).toContainText("Alice Ant");
  await bob.page.getByTestId("comment-text").fill("It matches the logo");
  await bob.page.getByTestId("comment-send").click();
  await expect(bob.page.getByTestId("comment-message")).toHaveCount(2);
  await expect(bobPin).toHaveAttribute("data-unread", "false");

  // Alice sees the reply on her pin, then resolves the thread; it leaves both boards.
  await expect(pin).toHaveAttribute("aria-label", /2 messages.*new/);
  await pin.click();
  await alice.page.getByTestId("comment-resolve").click();
  await expect(alice.page.getByTestId("comment-pin")).toHaveCount(0);
  // Bob still has the thread open, so his pin stays until he closes it.
  await expect(bobPin).toHaveAttribute("data-resolved", "true");
  await bob.page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(bob.page.getByTestId("comment-pin")).toHaveCount(0);
  await expect(alice.page.getByTestId("comments-menu")).toHaveAttribute("aria-label", "Comments");

  // Still in the list, with resolved ones shown.
  await openMenu(alice.page, "comments-menu");
  await alice.page.getByTestId("comments-open").click();
  await alice.page.getByTestId("comments-show-resolved").check();
  await expect(alice.page.getByTestId("comment-list-item")).toHaveCount(1);
  await expect(alice.page.getByTestId("comment-pin")).toHaveCount(1);

  await alice.context.close();
  await bob.context.close();
});

test("someone with a view link sees comments but can't add them", async ({ browser }) => {
  const alice = await person(browser, "Alice Ant");
  await openBoard(alice.page);
  await alice.page.keyboard.press("c");
  await alice.page.mouse.click(600, 400);
  await alice.page.getByTestId("comment-text").fill("Look here");
  await alice.page.getByTestId("comment-send").click();
  await expect(alice.page.getByTestId("comment-pin")).toHaveCount(1);

  const viewKey = await alice.page.evaluate(() => {
    const id = location.pathname.split("/").pop() ?? "";
    return JSON.parse(localStorage.getItem(`niro:keys:${id}`) ?? "{}").view as string | undefined;
  });
  expect(viewKey).toBeTruthy();
  const viewer = await person(browser, "Vera View");
  await viewer.page.goto(`${alice.page.url().split("#")[0]}#k=${viewKey}`);
  await waitUntilLive(viewer.page);
  await expect(viewer.page.getByTestId("comment-pin")).toHaveCount(1);
  await openMenu(viewer.page, "comments-menu");
  await expect(viewer.page.getByTestId("comment-add")).toBeDisabled();
  await viewer.page.keyboard.press("Escape");
  await viewer.page.getByTestId("comment-pin").click();
  await expect(viewer.page.getByTestId("comment-message")).toContainText("Look here");
  await expect(viewer.page.getByTestId("comment-text")).toHaveCount(0);
  await expect(viewer.page.getByTestId("comment-resolve")).toHaveCount(0);

  await alice.context.close();
  await viewer.context.close();
});
