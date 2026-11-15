import { expect, test } from "@playwright/test";

test("reference planes, bodies and sketches: show / hide, sketch on the chosen plane", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });

  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();

  // Shows the front plane and selects it (the "Références" section of the tree, collapsed by default).
  await page.locator(".tree-section-title", { hasText: "Références" }).click();
  const xz = page.locator(".tree-row", { hasText: "Face (XZ)" });
  await xz.getByRole("button").click();
  await expect(xz.getByRole("button")).toHaveText("●");
  await xz.click();
  await expect(xz).toHaveClass(/active/);

  // Hides the body.
  const body = page.locator(".tree-row", { hasText: "Corps" });
  await body.getByRole("button").click();
  await expect(body.getByRole("button")).toHaveText("◌");
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_DISP ?? "test-results/display.png" });

  // The sketch is created on the selected plane.
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator(".property-panel select").first()).toHaveValue("XZ");
  expect(errors).toEqual([]);
});
