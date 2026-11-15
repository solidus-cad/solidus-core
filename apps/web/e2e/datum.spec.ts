import { expect, test, type Page } from "@playwright/test";

async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  return errors;
}

test("part: offset plane, plane on a designated face, sketch on a plane", async ({ page }) => {
  const errors = await start(page);
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();

  // Plane offset from XY, chosen from the list of base planes.
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  const panel = page.locator(".datum-panel");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Plan ou axe de base").selectOption({ label: "Plan XY" });
  await expect(panel.locator(".datum-ref").first()).toHaveText("Plan XY");
  await panel.getByLabel("Distance").fill("60");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(page.locator(".tree-row", { hasText: "Plan1" })).toBeVisible();

  // Median plane: face designated in the view (first element), then Plan1.
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await panel.getByLabel("Méthode").selectOption({ label: "Médian (symétrique) / bissecteur" });
  await panel.locator(".datum-slot .refs-box").first().click();
  const box = (await page.locator(".viewport").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel.locator(".datum-ref").first()).toHaveText("Face plane");
  await panel.getByLabel("Plan ou axe de base").nth(1).selectOption({ label: "Plan1" });
  await expect(panel.locator(".panel-error")).toHaveCount(0);
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(page.locator(".tree-row", { hasText: "Plan2" })).toBeVisible();

  // Sketch on Plan1: select in the tree, then Sketch.
  await page.locator(".tree-row", { hasText: "Plan1" }).click();
  await page.getByRole("button", { name: "Esquisse", exact: true }).first().click();
  await expect(page.locator(".sk-panel select, .property-panel select").first()).toBeVisible();
  const planeSelect = page.locator("label.field", { hasText: "Plan" }).locator("select").first();
  await expect(planeSelect.locator("option:checked")).toHaveText("Plan1");
  await page.screenshot({ path: process.env.SHOT_DATUM ?? "test-results/datum.png" });
  expect(errors).toEqual([]);
});

test("assembly: reference plane on a base plane", async ({ page }) => {
  const errors = await start(page);
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  await expect(page.locator(".asm-name")).toHaveValue("Assemblage1");
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  const panel = page.locator(".datum-panel");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Plan ou axe de base").selectOption({ label: "Plan XZ" });
  await panel.getByLabel("Distance").fill("25");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(panel).toHaveCount(0);
  // Assembly planes: the "Références" section of the tree, collapsed by default.
  await page.locator(".tree-section-title", { hasText: "Références" }).click();
  await expect(page.locator(".tree-row", { hasText: "Plan1" })).toBeVisible();
  expect(errors).toEqual([]);
});
