import { defineConfig, devices } from "@playwright/test";

const port = 3100;

/** `pnpm bench`: builds nothing, so run `pnpm build` first. */
export default defineConfig({
  testDir: ".",
  testMatch: "bench.spec.ts",
  timeout: 180_000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    // Most laptops: four device pixels per CSS pixel to fill.
    deviceScaleFactor: 2,
  },
  webServer: {
    command: "pnpm --filter @niro/bench serve",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
