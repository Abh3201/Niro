import { defineConfig, devices } from "@playwright/test";

const port = 3000;
// Not 8787, so a realtime server left running by `pnpm dev` isn't picked up.
const realtimePort = 8788;
// Both servers sign and check share links with this. Test-only.
const secret = "e2e-only-secret-0123456789abcdef0123456789";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Lab L5: the browser's WebTransport against the lab's server, which it starts itself.
    {
      name: "labs",
      testDir: "labs/l5-transports/src",
      testMatch: "browser.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Runs the production builds, so `pnpm build` must come first.
  webServer: [
    {
      command: "pnpm --filter @niro/realtime start",
      url: `http://127.0.0.1:${realtimePort}/healthz`,
      env: {
        PORT: String(realtimePort),
        HOST: "127.0.0.1",
        NIRO_SECRET: secret,
        // Low, so a test can fill a board. No other test uses more than a few shapes.
        NIRO_MAX_SHAPES: "8",
      },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm --filter @niro/web start",
      url: `http://127.0.0.1:${port}`,
      env: {
        PORT: String(port),
        NIRO_SECRET: secret,
        PUBLIC_REALTIME_URL: `ws://127.0.0.1:${realtimePort}`,
      },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
