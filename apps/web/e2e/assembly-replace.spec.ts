import { expect, test, type Page } from "@playwright/test";

/** Pièce1: box whose height is driven by P1, a family of two configurations (P1 = 40, then 60). */
async function familyPart(page: Page) {
  const status = page.locator(".statusbar");
  await page.getByRole("button", { name: "+ Ajouter un paramètre" }).click();
  await page.getByLabel("Expression").fill("40");
  await page.getByLabel("Expression").press("Enter");
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.locator(".property-panel").getByLabel("Hauteur (Z)").fill("P1");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  await page.getByRole("button", { name: /Famille de pièces/ }).click();
  await page.getByRole("button", { name: "+ Créer depuis les paramètres" }).click();
  await page.getByRole("button", { name: "+ Configuration", exact: true }).click();
  const cell = page.locator(".family-table tbody tr").nth(1).getByLabel("P1");
  await cell.fill("60");
  await cell.press("Enter");
}

test("assembly: occurrence menu, replacement by another configuration of the family", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  await familyPart(page);

  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");

  // Constraint on the XY planes of both parts (kept on replacement).
  const planeSelect = page.locator("label.field", { hasText: "…ou un plan de pièce" }).locator("select");
  await page.getByRole("button", { name: "Coïncidence" }).click();
  await planeSelect.selectOption({ label: "Pièce1 <1> — Plan XY" });
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XY" });
  await expect(page.locator(".mate-row", { hasText: "Coïncidence · Pièce1 <1> / Pièce1 <2>" })).toBeVisible();

  // Context menu of the occurrence in the tree.
  await page.locator(".tree-row:not(.mate-row)", { hasText: "Pièce1 <2>" }).click({ button: "right" });
  const menu = page.locator(".menu-popup.context");
  for (const label of ["Masquer", "Ouvrir seul", "Modifier en place", "Remplacer…"]) await expect(menu.getByRole("button", { name: label, exact: true })).toBeVisible();
  await menu.getByRole("button", { name: "Remplacer…" }).click();

  // Family: the second configuration replaces the occurrence.
  const dialog = page.getByRole("dialog", { name: "Remplacer" });
  await expect(dialog).toBeVisible();
  await dialog.locator(".family-table tbody tr").nth(1).dblclick();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".tree-row:not(.mate-row)", { hasText: /Pièce1 - .+ <1>/ })).toBeVisible();
  // Constraint kept (it still targets the replaced occurrence), with no missing element.
  await expect(page.locator(".mate-row", { hasText: /Coïncidence · Pièce1 <1> \/ Pièce1 - .+ <1>/ })).toBeVisible();
  await expect(page.locator(".mate-row.error")).toHaveCount(0);
  // The new part has the chosen configuration.
  await page.locator(".tree-row:not(.mate-row)", { hasText: /Pièce1 - .+ <1>/ }).dblclick();
  await expect(status).toContainText("Volume 360 cm³");
  await page.getByRole("button", { name: "↩ Retour à l'assemblage" }).click();

  // Right-click in the view on an occurrence: same menu.
  await page.waitForTimeout(800);
  const box = (await page.locator(".viewport canvas").first().boundingBox())!;
  // The framing depends on the layout of the parts: scan the central area until an occurrence is hit.
  let found = false;
  for (let fy = 0.3; fy <= 0.7 && !found; fy += 0.05) {
    for (let fx = 0.3; fx <= 0.7 && !found; fx += 0.05) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: "right" });
      found = await menu.getByRole("button", { name: "Remplacer…" }).isVisible();
    }
  }
  expect(found).toBe(true);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);

  // In-place editing: the part opens with the context banner.
  await page.locator(".tree-row:not(.mate-row)", { hasText: "Pièce1 <1>" }).click({ button: "right" });
  await menu.getByRole("button", { name: "Modifier en place" }).click();
  await expect(page.locator(".context-banner")).toContainText("Modification en place");
  await page.waitForTimeout(800);
  await page.screenshot({ path: process.env.SHOT_INPLACE ?? "test-results/assembly-inplace.png" });
  await page.getByRole("button", { name: "↩ Retour à l'assemblage" }).click();
  await expect(status).toContainText("2 occurrence(s)");
  expect(errors).toEqual([]);
});
