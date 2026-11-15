import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests (Node). End-to-end tests are in e2e/ (Playwright).
export default defineConfig({
  resolve: { alias: { "@app": fileURLToPath(new URL("../../apps/web/src", import.meta.url)) } },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
