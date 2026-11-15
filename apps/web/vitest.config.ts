import { defineConfig } from "vitest/config";

// Unit tests (pure logic, Node): without the Solid plugin of vite.config.ts. End-to-end tests are in e2e/ (Playwright).
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
