import { type Browser, expect, type Page, test } from "@playwright/test";
import { expectPixel, expectStatus, openBoard, RED, waitUntilLive } from "./helpers";

async function person(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** A PNG of one color, made by the browser. */
async function solidPng(page: Page, width: number, height: number, color: string) {
  const base64 = await page.evaluate(
    ({ width, height, color }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL("image/png").split(",")[1] as string;
    },
    { width, height, color },
  );
  return Buffer.from(base64, "base64");
}

test("an image added from a file shows for everyone, and people react to it", async ({
  browser,
}) => {
  const alice = await person(browser);
  const bob = await person(browser);
  await openBoard(alice.page);
  await bob.page.goto(alice.page.url());
  await waitUntilLive(bob.page);

  const png = await solidPng(alice.page, 200, 150, "#ef4444");
  await alice.page
    .getByTestId("image-file")
    .setInputFiles({ name: "red.png", mimeType: "image/png", buffer: png });
  // Added in the middle of the screen, at its own size, and selected.
  await expectStatus(alice.page, 1, 1);
  await expectPixel(alice.page, 640, 360, RED);
  await expectPixel(bob.page, 640, 360, RED);

  await alice.page.getByTestId("react-like").click();
  await expect(alice.page.getByTestId("react-like")).toHaveAttribute("aria-pressed", "true");
  await expect(alice.page.getByTestId("react-like")).toContainText("1");

  await bob.page.mouse.click(640, 360);
  await expectStatus(bob.page, 1, 1);
  await expect(bob.page.getByTestId("react-like")).toHaveAttribute("aria-pressed", "false");
  await bob.page.getByTestId("react-like").click();
  await expect(bob.page.getByTestId("react-like")).toContainText("2");
  await expect(alice.page.getByTestId("react-like")).toContainText("2");

  // Taking yours back leaves the other person's.
  await alice.page.getByTestId("react-like").click();
  await expect(alice.page.getByTestId("react-like")).toHaveAttribute("aria-pressed", "false");
  await expect(bob.page.getByTestId("react-like")).toContainText("1");

  await alice.context.close();
  await bob.context.close();
});

test("a pasted image is added, and a file that isn't an image is refused", async ({ page }) => {
  await openBoard(page);
  await page
    .getByTestId("image-file")
    .setInputFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("not a png") });
  await expect(page.getByTestId("image-notice")).toContainText("couldn't be read");
  await expectStatus(page, 0, 0);

  const png = await solidPng(page, 120, 80, "#ef4444");
  await page.evaluate(
    async (bytes) => {
      const file = new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
    },
    [...png],
  );
  await expectStatus(page, 1, 1);
  await expectPixel(page, 640, 360, RED);
});
