import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  BLUE,
  drag,
  drawRectangle,
  expectPixel,
  expectStatus,
  layerPixelAt,
  openBoard,
  TRANSPARENT,
  waitUntilLive,
} from "./helpers";

// Each person is a separate browser context: their own storage, their own
// connection. Same viewport, so the same world point is at the same pixel.
async function person(browser: Browser, identity?: { name: string; color: string }) {
  const context = await browser.newContext();
  if (identity) {
    await context.addInitScript((value) => {
      localStorage.setItem("niro:identity", value);
    }, JSON.stringify(identity));
  }
  return { context, page: await context.newPage() };
}

async function join(page: Page, link: string) {
  await page.goto(link);
  await waitUntilLive(page);
}

test("two editors on one link see each other's shapes, cursor and name", async ({ browser }) => {
  const alice = await person(browser);
  const bob = await person(browser, { name: "Bob Builder", color: "#b91c1c" });
  await openBoard(alice.page);
  await join(bob.page, alice.page.url());

  await drawRectangle(alice.page, { x: 520, y: 280 }, { x: 760, y: 440 });
  await expectPixel(bob.page, 640, 360, BLUE);
  await expectStatus(bob.page, 1, 0);

  await drawRectangle(bob.page, { x: 100, y: 100 }, { x: 200, y: 200 });
  await expectPixel(alice.page, 150, 150, BLUE);
  await expectStatus(alice.page, 2, 1);

  const avatars = alice.page.getByTestId("avatar");
  await expect(avatars).toHaveCount(1);
  await expect(avatars).toHaveAttribute("title", "Follow Bob Builder");

  // Bob's pointer, drawn on Alice's screen in his color: (2, 10) is inside the arrow.
  await bob.page.mouse.move(300, 500, { steps: 4 });
  await expect
    .poll(() => layerPixelAt(alice.page, "overlay", 302, 510))
    .toEqual([185, 28, 28, 255]);

  await bob.context.close();
  await expect(avatars).toHaveCount(0);
  await alice.context.close();
});

test("a view link shows the board live but can't change it", async ({ browser }) => {
  const editor = await person(browser);
  const viewer = await person(browser);
  await openBoard(editor.page);
  await drawRectangle(editor.page, { x: 520, y: 280 }, { x: 760, y: 440 });

  await editor.page.getByTestId("share-button").click();
  const viewLink = await editor.page.getByTestId("share-view-link").inputValue();
  expect(viewLink).toMatch(/\/b\/[A-Za-z0-9_-]+#k=v\.[A-Za-z0-9_-]{22}$/);

  await join(viewer.page, viewLink);
  await expect(viewer.page.getByTestId("view-only")).toBeVisible();
  await expectPixel(viewer.page, 640, 360, BLUE);
  await expect(viewer.page.getByTestId("tool-rectangle")).toHaveCount(0);

  // Try anyway: a shortcut and a drag, then select the shape and delete it.
  await viewer.page.keyboard.press("r");
  await drag(viewer.page, { x: 100, y: 100 }, { x: 200, y: 200 });
  await viewer.page.mouse.click(640, 360);
  await viewer.page.keyboard.press("Delete");
  await expectStatus(viewer.page, 1, 1);

  // The editor's changes still reach the viewer, and the viewer's never left it.
  await editor.page.keyboard.press("Escape");
  await drawRectangle(editor.page, { x: 900, y: 100 }, { x: 1000, y: 200 });
  await expectPixel(viewer.page, 950, 150, BLUE);
  await expectStatus(editor.page, 2, 1);
  await expectPixel(editor.page, 640, 360, BLUE);

  // A viewer can pass on the view link, and has no edit link to hand out.
  await viewer.page.getByTestId("share-button").click();
  await expect(viewer.page.getByTestId("share-view-link")).toHaveValue(viewLink);
  await expect(viewer.page.getByTestId("share-edit-link")).toHaveCount(0);

  await editor.context.close();
  await viewer.context.close();
});

test("a link with a made-up key gets no access", async ({ page }) => {
  await page.goto("/b/abcdefgh12345678#k=e.AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByTestId("board")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("sync-status")).toHaveText("No access");
  await expect(page.getByRole("alert")).toContainText("doesn't give access");
  await expect(page.getByTestId("tool-rectangle")).toHaveCount(0);
});

test("a full board turns read-only for everyone, and says why", async ({ browser }) => {
  const alice = await person(browser);
  const bob = await person(browser);
  await openBoard(alice.page);
  await join(bob.page, alice.page.url());

  // The e2e server allows 8 shapes a board: draw one, then double it three times.
  await drawRectangle(alice.page, { x: 100, y: 100 }, { x: 160, y: 160 });
  for (const count of [2, 4, 8]) {
    await alice.page.keyboard.press("ControlOrMeta+a");
    await alice.page.keyboard.press("ControlOrMeta+d");
    await expectStatus(bob.page, count, 0);
  }

  for (const { page } of [alice, bob]) {
    await expect(page.getByText("This board has reached its size limit")).toBeVisible();
    await expect(page.getByTestId("tool-rectangle")).toHaveCount(0);
  }
  // Nothing more gets in, by shortcut or by drawing.
  await alice.page.keyboard.press("ControlOrMeta+a");
  await alice.page.keyboard.press("ControlOrMeta+d");
  await bob.page.keyboard.press("r");
  await drag(bob.page, { x: 600, y: 300 }, { x: 700, y: 400 });
  await alice.page.waitForTimeout(300);
  await expectStatus(alice.page, 8, 8);
  await expectStatus(bob.page, 8, 0);

  await alice.context.close();
  await bob.context.close();
});

test("two people typing in one sticky note at once both keep their text", async ({ browser }) => {
  const alice = await person(browser);
  const bob = await person(browser);
  await openBoard(alice.page);
  await alice.page.keyboard.press("n");
  await alice.page.mouse.click(640, 360);
  await alice.page.keyboard.press("Escape");
  await join(bob.page, alice.page.url());
  await expectStatus(bob.page, 1, 0);

  await alice.page.mouse.dblclick(640, 360);
  await bob.page.mouse.dblclick(640, 360);
  const aliceEditor = alice.page.getByTestId("text-editor");
  const bobEditor = bob.page.getByTestId("text-editor");
  await expect(aliceEditor).toBeFocused();
  await expect(bobEditor).toBeFocused();
  // The same characters at the same moment: the hard case for keeping each
  // person's cursor on their own text.
  await Promise.all([
    alice.page.keyboard.type("hello from alice", { delay: 20 }),
    bob.page.keyboard.type("hello from bob", { delay: 25 }),
  ]);

  // Each sees the other's typing in their own editor as it happens, and
  // kept typing where their own cursor was: two whole runs, in an order
  // the CRDT picks.
  const both = /^(hello from alicehello from bob|hello from bobhello from alice)$/;
  await expect(aliceEditor).toHaveValue(both);
  await expect(bobEditor).toHaveValue(both);
  expect(await aliceEditor.inputValue()).toBe(await bobEditor.inputValue());

  await alice.context.close();
  await bob.context.close();
});

test("text typed with an input method arrives whole, after someone else's typing", async ({
  browser,
}) => {
  const alice = await person(browser);
  const bob = await person(browser);
  await openBoard(alice.page);
  await alice.page.keyboard.press("n");
  await alice.page.mouse.click(640, 360);
  await alice.page.keyboard.type("ab");
  await alice.page.keyboard.press("Escape");
  await join(bob.page, alice.page.url());
  await alice.page.mouse.dblclick(640, 360);
  await bob.page.mouse.dblclick(640, 360);
  const aliceEditor = alice.page.getByTestId("text-editor");
  const bobEditor = bob.page.getByTestId("text-editor");
  await expect(bobEditor).toHaveValue("ab");

  // Alice composes Japanese between "a" and "b", the way an input method
  // does: the text changes in place until it's committed.
  await alice.page.keyboard.press("ArrowLeft");
  const ime = await alice.page.context().newCDPSession(alice.page);
  await ime.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await ime.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  await expect(aliceEditor).toHaveValue("aにほb");
  // Meanwhile Bob types at the start. Nothing reaches Alice's editor until
  // she commits, which would break her composition.
  await bob.page.keyboard.press("Home");
  await bob.page.keyboard.type("X");
  // Long enough for Bob's "X" to reach Alice mid-composition, the case
  // this test is for; if it came later, the test would still pass.
  await alice.page.waitForTimeout(300);
  await ime.send("Input.insertText", { text: "日本" });

  await expect(aliceEditor).toHaveValue("Xa日本b");
  await expect(bobEditor).toHaveValue("Xa日本b");
  // Her cursor is still right after what she wrote.
  await alice.page.keyboard.type("!");
  await expect(bobEditor).toHaveValue("Xa日本!b");

  await alice.context.close();
  await bob.context.close();
});

test("clicking someone's avatar follows their view until you move yourself", async ({
  browser,
}) => {
  const alice = await person(browser);
  const bob = await person(browser, { name: "Bob Builder", color: "#b91c1c" });
  await openBoard(alice.page);
  await join(bob.page, alice.page.url());
  await drawRectangle(alice.page, { x: 520, y: 280 }, { x: 760, y: 440 });
  await expectPixel(bob.page, 640, 360, BLUE);

  await alice.page.getByTestId("avatar").click();
  await expect(alice.page.getByTestId("following")).toHaveText(/Following Bob Builder/);

  // Bob pans 300px left; Alice's view follows.
  await bob.page.mouse.move(640, 600);
  await bob.page.mouse.wheel(300, 0);
  await expectPixel(bob.page, 340, 360, BLUE);
  await expectPixel(alice.page, 340, 360, BLUE);
  await expectPixel(alice.page, 640, 360, TRANSPARENT);

  // Alice pans herself: she stops following, and Bob's next move doesn't move her.
  await alice.page.mouse.move(640, 600);
  await alice.page.mouse.wheel(0, 100);
  await expect(alice.page.getByTestId("following")).toHaveCount(0);
  await bob.page.mouse.wheel(100, 0);
  await expectPixel(bob.page, 240, 360, BLUE);
  await expectPixel(alice.page, 340, 260, BLUE);

  await bob.context.close();
  await alice.context.close();
});

test("a laser pointer shows to everyone, and viewers can use it", async ({ browser }) => {
  const editor = await person(browser);
  const viewer = await person(browser, { name: "Vera View", color: "#b91c1c" });
  await openBoard(editor.page);
  await editor.page.getByTestId("share-button").click();
  const viewLink = await editor.page.getByTestId("share-view-link").inputValue();
  await join(viewer.page, viewLink);
  await expect(viewer.page.getByTestId("view-only")).toBeVisible();

  await viewer.page.keyboard.press("k");
  await expect(viewer.page.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
  await viewer.page.mouse.move(300, 500);
  await viewer.page.mouse.down();
  await viewer.page.mouse.move(305, 500, { steps: 3 });
  // The dot is drawn in her color just up and left of where the pointer is, then fades.
  await expect
    .poll(async () => {
      const [r = 0, , , a = 0] = await layerPixelAt(editor.page, "overlay", 303, 498);
      return a > 60 && r > 150;
    })
    .toBe(true);
  await viewer.page.mouse.up();
  await expect
    .poll(async () => (await layerPixelAt(editor.page, "overlay", 303, 498))[3], { timeout: 4000 })
    .toBe(0);

  await viewer.context.close();
  await editor.context.close();
});
