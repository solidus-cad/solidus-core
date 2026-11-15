import { defineConfig, devices } from "@playwright/test";

/** End-to-end tests for the gears module: the application is built with the module (CAD_EXTENSIONS). */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5180", locale: "fr-FR", screenshot: "only-on-failure", viewport: { width: 1440, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "pnpm --dir ../../apps/web exec vite --port 5180 --strictPort",
    url: "http://localhost:5180",
    reuseExistingServer: true,
    env: { CAD_EXTENSIONS: "../../modules/gears/src/extension.tsx" },
  },
});
