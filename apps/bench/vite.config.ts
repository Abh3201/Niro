import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // Two copies of Yjs in one page break `instanceof` checks.
    dedupe: ["yjs"],
  },
});
