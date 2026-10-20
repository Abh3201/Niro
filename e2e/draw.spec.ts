import { expect, test } from "@playwright/test";
import { drag, drawRectangle, expectStatus, inkPixels, openBoard } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openBoard(page);
});

test("the pen draws strokes until another tool is picked, each one undone on its own", async ({
  page,
}) => {
  await page.keyboard.press("p");
  await drag(page, { x: 300, y: 300 }, { x: 500, y: 320 }, 20);
  const stroke = { x: 290, y: 290, width: 220, height: 40 };
  await expect.poll(() => inkPixels(page, stroke)).toBeGreaterThan(150);
  await expectStatus(page, 1, 0);
  await expect(page.getByTestId("tool-pen")).toHaveAttribute("aria-pressed", "true");

  await drag(page, { x: 300, y: 400 }, { x: 500, y: 380 }, 20);
  await expectStatus(page, 2, 0);
  await page.keyboard.press("Control+z");
  await expectStatus(page, 1, 0);
  await expect.poll(() => inkPixels(page, stroke)).toBeGreaterThan(150);
});

test("an arrow stays attached to the shapes it connects as they move", async ({ page }) => {
  await drawRectangle(page, { x: 200, y: 200 }, { x: 300, y: 300 });
  await drawRectangle(page, { x: 500, y: 200 }, { x: 600, y: 300 });
  await page.keyboard.press("a");
  await drag(page, { x: 250, y: 250 }, { x: 550, y: 250 });
  await expectStatus(page, 3, 1);
  // Black between the boxes, along y = 250.
  const straight = { x: 330, y: 244, width: 140, height: 12 };
  await expect.poll(() => inkPixels(page, straight)).toBeGreaterThan(100);

  // Move the right-hand box down 200: the arrow now runs diagonally to it.
  await page.mouse.click(800, 600);
  await drag(page, { x: 560, y: 260 }, { x: 560, y: 460 });
  await expectStatus(page, 3, 1);
  await expect.poll(() => inkPixels(page, straight)).toBe(0);
  // Halfway between the centers (250, 250) and (550, 450).
  await expect
    .poll(() => inkPixels(page, { x: 390, y: 340, width: 20, height: 20 }))
    .toBeGreaterThan(20);
});

test.describe("with a pen on a touch screen", () => {
  test.use({ hasTouch: true });

  test("pressing harder draws thicker, and a resting palm doesn't interrupt the stroke", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    const pen = (
      type: "mousePressed" | "mouseMoved" | "mouseReleased",
      x: number,
      y: number,
      force: number,
    ) =>
      cdp.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        force,
        pointerType: "pen",
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });
    /** A horizontal stroke at `y`, pressure wavering around `force` so it reads as sensed. */
    const stroke = async (y: number, force: number, during?: () => Promise<void>) => {
      await pen("mousePressed", 300, y, force);
      for (let i = 1; i <= 20; i++) {
        await pen("mouseMoved", 300 + i * 10, y, force + (i % 2) * 0.05);
        if (i === 10) await during?.();
      }
      await pen("mouseReleased", 500, y, 0);
    };

    await page.keyboard.press("p");
    await stroke(250, 0.1);
    await stroke(450, 0.9, async () => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 900, y: 600 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 920, y: 610 }],
      });
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    // Both strokes are there: the palm neither cancelled the second nor drew.
    await expectStatus(page, 2, 0);
    const light = await inkPixels(page, { x: 320, y: 230, width: 160, height: 40 });
    const heavy = await inkPixels(page, { x: 320, y: 430, width: 160, height: 40 });
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light * 1.5);
    expect(await inkPixels(page, { x: 880, y: 580, width: 60, height: 60 })).toBe(0);
  });
});

test("ink drawn on a sticky note moves with it, and Alt draws on the board instead", async ({
  page,
}) => {
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(400, 400);
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  // Starts on the note (it spans about 300 to 500) and runs past its edge.
  await drag(page, { x: 330, y: 330 }, { x: 560, y: 330 }, 20);
  await page.keyboard.down("Alt");
  await drag(page, { x: 330, y: 460 }, { x: 460, y: 460 }, 20);
  await page.keyboard.up("Alt");
  await expectStatus(page, 3, 1);
  const onBoard = { x: 320, y: 450, width: 150, height: 20 };
  await expect.poll(() => inkPixels(page, onBoard)).toBeGreaterThan(50);

  await page.keyboard.press("v");
  // Grab the note by empty paper and move it down 150.
  await drag(page, { x: 350, y: 380 }, { x: 350, y: 530 }, 10);
  await expect
    .poll(() => inkPixels(page, { x: 330, y: 470, width: 220, height: 30 }))
    .toBeGreaterThan(50);
  // The Alt stroke stayed on the board.
  await expect.poll(() => inkPixels(page, onBoard)).toBeGreaterThan(50);
});
