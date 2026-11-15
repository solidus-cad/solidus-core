import { defineConfig, devices } from "@playwright/test";

/** End-to-end tests for the motion module: the application is built with the module (CAD_EXTENSIONS). */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5179", locale: "fr-FR", screenshot: "only-on-failure", viewport: { width: 1440, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "pnpm --dir ../../apps/web exec vite --port 5179 --strictPort",
    url: "http://localhost:5179",
    reuseExistingServer: true,
    env: { CAD_EXTENSIONS: "../../modules/motion/src/extension.tsx" },
  },
});
