import { expect, test } from "@playwright/test";

// Google's OAuth verification needs a public home page that describes the
// app and links to the privacy policy, and a policy on the same site.

test("about, privacy and terms are public and link to each other", async ({ page }) => {
  const about = await page.goto("/about");
  expect(about?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start a board" }).first()).toHaveAttribute(
    "href",
    "/",
  );

  const footer = page.getByRole("navigation", { name: "About Niro" });
  await footer.getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
  await expect(page.getByText("Test Operator").first()).toBeVisible();
  await expect(page.getByTestId("contact-email").first()).toHaveAttribute(
    "href",
    "mailto:privacy@example.com",
  );
  // No Google sign-in on this server, so no section about it.
  await expect(page.locator("#google")).toHaveCount(0);

  await footer.getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole("heading", { name: "Terms of service" })).toBeVisible();
  await expect(page.getByRole("link", { name: "privacy policy" })).toHaveAttribute(
    "href",
    "/privacy",
  );
});

test.describe("with accounts", () => {
  const BASE = "http://127.0.0.1:3002";
  test.skip(!process.env.TEST_DATABASE_URL, "needs TEST_DATABASE_URL, for the accounts server");

  test("sign-in links the policy, which covers Google user data", async ({ page }) => {
    await page.goto(`${BASE}/signin`);
    const legal = page.getByTestId("signin-legal");
    await expect(legal.getByRole("link", { name: "privacy policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    await expect(legal.getByRole("link", { name: "terms" })).toHaveAttribute("href", "/terms");

    await legal.getByRole("link", { name: "privacy policy" }).click();
    const google = page.locator("#google");
    await expect(google).toBeVisible();
    await expect(page.getByText("including the Limited Use requirements")).toBeVisible();
    // No contact set on this server: the page says so instead of a broken link.
    await expect(page.getByTestId("contact-missing").first()).toBeVisible();
  });
});
