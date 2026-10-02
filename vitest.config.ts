import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's "@/…" alias, for its unit tests (apps/admin has none yet).
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    // Simulation tests play whole careers (60 days × 360-minute nights); CI runners are ~2× slower than a dev
    // laptop, so the default 5 s is too tight.
    testTimeout: 60_000,
    include: ["packages/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
