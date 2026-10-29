import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's `~/` imports.
  resolve: { alias: { "~": fileURLToPath(new URL("apps/web/app", import.meta.url)) } },
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/web/app/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "labs/*/src/**/*.test.ts",
    ],
    environment: "node",
  },
});
