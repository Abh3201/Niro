import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { drawRectangle, waitUntilLive } from "./helpers";

// The web app with accounts that playwright.config.ts starts when
// TEST_DATABASE_URL is set, and where it writes its sign-in emails.
const BASE = "http://127.0.0.1:3002";
const OUTBOX = join(tmpdir(), "niro-e2e-outbox.jsonl");

test.skip(!process.env.TEST_DATABASE_URL, "needs TEST_DATABASE_URL, for the accounts database");

/** A new address per test, so tests don't see each other's boards. */
const newEmail = () => `e2e-${randomBytes(5).toString("hex")}@example.com`;

/** The sign-in link most recently emailed to `email`. */
async function linkFor(email: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(async () => {
      const lines = (await readFile(OUTBOX, "utf8").catch(() => "")).trim().split("\n");
      const mail = lines
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { to: string; text: string })
        .filter((m) => m.to === email)
        .at(-1);
      link = mail?.text.match(/https?:\/\/\S+/)?.[0];
      return link;
    })
    .toBeTruthy();
  return link as string;
}

/**
 * Sign-in emails are limited per IP (5 in 10 minutes), and every test runs
 * from 127.0.0.1: each page claims an address of its own, as a proxy would
 * report it.
 */
async function ownIp(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.${[...randomBytes(3)].join(".")}` });
}

/** Signs in with an emailed link, starting from the sign-in page, and lands on `next`. */
async function signIn(page: Page, email: string, next = "/boards"): Promise<void> {
  await ownIp(page);
  await page.goto(`${BASE}/signin?next=${encodeURIComponent(next)}`);
  await page.getByTestId("signin-email").fill(email);
  await page.getByTestId("send-link").click();
  await expect(page.getByTestId("link-sent")).toContainText(email);
  await page.goto(await linkFor(email));
}

/** A fresh browser (another device): nothing saved, not signed in. */
async function otherDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  return context.newPage();
}

test("sign in by email, make boards, rename them, and open them on another device", async ({
  page,
  browser,
}) => {
  const email = newEmail();
  await signIn(page, email);
  await expect(page).toHaveURL(`${BASE}/boards`);
  await expect(page.getByTestId("no-boards")).toBeVisible();

  await page.getByTestId("new-board").click();
  await expect(page).toHaveURL(/\/b\/[A-Za-z0-9_-]+#k=e\./);
  await waitUntilLive(page);
  const boardUrl = new URL(page.url());
  await drawRectangle(page, { x: 500, y: 300 }, { x: 640, y: 400 });
  await page.getByTestId("board-title").click();
  await page.getByTestId("board-title-input").fill("Sprint plan");
  await page.getByTestId("board-title-input").press("Enter");
  await expect(page.getByTestId("board-title")).toHaveText("Sprint plan");

  await page.getByTestId("account-button").click();
  await page.getByTestId("my-boards").click();
  await expect(page.getByTestId("my-boards-list").getByTestId("board-card-title")).toHaveText([
    "Sprint plan",
  ]);

  // Another device: no link, no saved key. The account opens the board, as its editor.
  const other = await otherDevice(browser);
  await signIn(other, email);
  await other.getByTestId("board-card-title").first().click();
  await expect(other).toHaveURL(new RegExp(`${boardUrl.pathname}#k=e\\.`));
  await waitUntilLive(other);
  await expect(other.getByTestId("view-only")).toHaveCount(0);
  await expect(other.getByTestId("board-title")).toHaveText("Sprint plan");
  await other.context().close();
});

test("a board made signed out can be saved to the account", async ({ page }) => {
  await ownIp(page);
  await page.goto(`${BASE}/`);
  await expect(page).toHaveURL(/\/b\/[A-Za-z0-9_-]+#k=e\./);
  await waitUntilLive(page);
  const path = new URL(page.url()).pathname;

  await page.getByTestId("sign-in").click();
  const email = newEmail();
  await page.getByTestId("signin-email").fill(email);
  await page.getByTestId("send-link").click();
  await page.goto(await linkFor(email));
  // Back on the board, signed in.
  await expect(page).toHaveURL(new RegExp(path));
  await waitUntilLive(page);
  await page.getByTestId("account-button").click();
  await page.getByTestId("claim-board").click();
  await expect(page.getByTestId("claim-result")).toContainText("yours now");

  await page.goto(`${BASE}/boards`);
  await expect(page.getByTestId("my-boards-list").getByTestId("board-card")).toHaveCount(1);
});

test("boards opened with someone's link are listed as shared, with that link's access", async ({
  page,
  browser,
}) => {
  await signIn(page, newEmail());
  await page.getByTestId("new-board").click();
  await waitUntilLive(page);
  await page.getByTestId("share-button").click();
  const viewLink = await page.getByTestId("share-view-link").inputValue();

  const friend = await otherDevice(browser);
  await signIn(friend, newEmail(), "/boards");
  await friend.goto(viewLink);
  await waitUntilLive(friend);
  await expect(friend.getByTestId("view-only")).toBeVisible();
  await friend.goto(`${BASE}/boards`);
  const shared = friend.getByTestId("shared-boards-list").getByTestId("board-card");
  await expect(shared).toHaveCount(1);
  await expect(shared).toContainText("Can view");
  await expect(friend.getByTestId("rename-board")).toHaveCount(0);
  await expect(friend.getByTestId("delete-board")).toHaveCount(0);

  await friend.getByTestId("remove-board").click();
  await expect(friend.getByTestId("shared-boards-list")).toHaveCount(0);
  await friend.context().close();
});

test("deleting a board stops its links working", async ({ page, browser }) => {
  await signIn(page, newEmail());
  await page.getByTestId("new-board").click();
  await waitUntilLive(page);
  const editLink = page.url();

  await page.goto(`${BASE}/boards`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("delete-board").click();
  await expect(page.getByTestId("no-boards")).toBeVisible();

  const stranger = await otherDevice(browser);
  const response = await stranger.goto(editLink);
  expect(response?.status()).toBe(410);
  await expect(stranger.getByRole("heading", { name: "Board deleted" })).toBeVisible();
  // And no token, for a page that was already open.
  const token = await stranger.request.post(`${BASE}/api/token`, {
    data: { boardId: new URL(editLink).pathname.split("/")[2], key: editLink.split("#k=")[1] },
  });
  expect(token.status()).toBe(410);
  await stranger.context().close();
});

test("boards this browser opened before signing in can be added to the list", async ({ page }) => {
  for (let i = 0; i < 2; i++) {
    await page.goto(`${BASE}/`);
    await waitUntilLive(page);
  }
  await signIn(page, newEmail());
  await expect(page.getByTestId("import-offer")).toContainText("2 boards");
  await page.getByTestId("import-boards").click();
  await expect(page.getByTestId("import-done")).toContainText("Added 2 boards");
  await expect(page.getByTestId("shared-boards-list").getByTestId("board-card")).toHaveCount(2);
});

test("sign out", async ({ page }) => {
  await signIn(page, newEmail());
  await page.getByTestId("account-button").click();
  await page.getByTestId("sign-out").click();
  // Signed out, the home page makes a new board again.
  await expect(page).toHaveURL(/\/b\/[A-Za-z0-9_-]+#k=e\./);
  await expect(page.getByTestId("sign-in")).toBeVisible();
});
