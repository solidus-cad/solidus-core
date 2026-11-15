import { expect, test } from "@playwright/test";

test("Tools workbench: liaison graph of an assembly", async ({ page }) => {
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
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");

  // On a part, the graph is not available.
  await page.getByRole("tab", { name: "Outils", exact: true }).click();
  await expect(page.getByRole("button", { name: "Graphe des liaisons" })).toBeDisabled();

  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("3 occurrence(s)");
  const planeSelect = page.locator("label.field", { hasText: "…ou un plan de pièce" }).locator("select");
  // <2> on <1>: XY planes coincident (appui plan).
  await page.getByRole("button", { name: "Coïncidence" }).click();
  await planeSelect.selectOption({ label: "Pièce1 <1> — Plan XY" });
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XY" });
  await expect(page.locator(".mate-row", { hasText: "Pièce1 <1> / Pièce1 <2>" })).toBeVisible();
  // <3> on <2>: XZ planes parallel and XY planes at 15 mm (two translations left: compound joint).
  await page.getByRole("button", { name: "Parallèle" }).click();
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XZ" });
  await planeSelect.selectOption({ label: "Pièce1 <3> — Plan XZ" });
  await page.getByRole("button", { name: "Distance" }).click();
  await page.locator("label.field", { hasText: "Valeur (mm)" }).locator("input").fill("15");
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XY" });
  await planeSelect.selectOption({ label: "Pièce1 <3> — Plan XY" });
  await expect(page.locator(".mate-row", { hasText: "Distance · Pièce1 <2> / Pièce1 <3>" })).toBeVisible();

  await page.getByRole("tab", { name: "Outils", exact: true }).click();
  await page.getByRole("button", { name: "Graphe des liaisons" }).click();
  const panel = page.locator(".measure-panel");
  await expect(panel).toContainText("Graphe des liaisons");
  // Three bubbles: the ground (fixed first occurrence) and the two moving parts.
  await expect(panel.locator(".lia-node")).toHaveCount(3);
  await expect(panel.locator(".lia-node.ground")).toHaveCount(1);
  await expect(panel.locator(".lia-edge")).toHaveCount(2);
  await expect(panel.locator(".lia-table")).toContainText("Appui plan");
  await expect(panel.locator(".lia-table")).toContainText("Normale Z");
  await expect(panel.locator(".lia-table")).toContainText("Liaison composée");
  await expect(panel.locator(".lia-table")).toContainText("0 rotation(s) · 2 translation(s)");
  await expect(panel.locator(".meas-grid")).toContainText("Mobilité");

  // A bubble selects its parts.
  await panel.locator(".lia-node:not(.ground)").first().click();
  await expect(panel.locator(".lia-node.selected")).toHaveCount(1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.SHOT_LIA ?? "test-results/liaisons.png" });
  expect(errors).toEqual([]);
});
