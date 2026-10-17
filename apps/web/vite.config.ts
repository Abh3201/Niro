import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    tsconfigPaths: true,
    // Two copies of Yjs in one page break `instanceof` checks and sync.
    dedupe: ["yjs"],
  },
});
