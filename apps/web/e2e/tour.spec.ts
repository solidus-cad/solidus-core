import { expect, test } from "@playwright/test";

/** Guided tour "first part": each step follows the document, up to the extruded plate. */
test("guided tour: first part", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  const box = (await page.locator(".viewport").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const bubble = page.locator(".tour-bubble");

  // Offered from the empty tree (no automatic offer under automation).
  await expect(bubble).toHaveCount(0);
  await page.locator(".tree-tour").click();
  await bubble.getByRole("button", { name: "Commencer" }).click();

  // Web version: the project folder first (skippable).
  await expect(bubble).toContainText("Choisir le dossier projet");
  await expect(bubble).toContainText("version web");
  await bubble.getByRole("button", { name: "Passer" }).click();

  await expect(bubble).toContainText("Ouvrir une esquisse");
  await expect(page.locator(".tour-spot")).toBeVisible();
  await page.locator('.ribbon-btn[data-cmd="part.sketch"]').click();

  await expect(bubble).toContainText("Choisir l'outil Rectangle");
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  await page.locator('.ribbon-btn[data-action="sketch.rect"]').click();

  await expect(bubble).toContainText("Tracer le rectangle");
  await page.mouse.click(cx - 120, cy - 80);
  await page.mouse.click(cx + 120, cy + 80);

  // Optional dimensions: skipped.
  await expect(bubble).toContainText("Coter le rectangle");
  await bubble.getByRole("button", { name: "Passer" }).click();

  await expect(bubble).toContainText("Terminer l'esquisse");
  await page.locator('.ribbon-btn[data-action="global.confirm"]').click();

  await expect(bubble).toContainText("Extruder");
  await page.locator('.ribbon-btn[data-cmd="part.extrude"]').click();

  await expect(bubble).toContainText("Régler l'épaisseur");
  await page.locator(".property-panel").getByLabel("Longueur").last().fill("10");
  await page.getByRole("button", { name: "✓ Valider" }).click();

  await expect(bubble).toContainText("Pièce créée");
  // The closing card offers the example assemblies.
  await expect(bubble.locator(".example-card")).toHaveCount(3);
  await expect(bubble.locator(".example-card", { hasText: "Cardan double" })).toBeVisible();
  await bubble.getByRole("button", { name: "Fermer" }).click();
  await expect(bubble).toHaveCount(0);

  // Restarted from the Help menu on a part that has features: a new part is opened.
  await page.getByRole("button", { name: "Aide", exact: true }).click();
  await page.getByRole("button", { name: /Visite guidée/ }).click();
  await bubble.getByRole("button", { name: "Commencer" }).click();
  await expect(page.locator(".doc-tab", { hasText: "Pièce2" })).toBeVisible();
  await expect(bubble).toContainText("Choisir le dossier projet");
  await bubble.getByRole("button", { name: "Passer" }).click();
  await expect(bubble).toContainText("Ouvrir une esquisse");

  // Another document: paused, then back.
  await page.locator(".doc-tab-name", { hasText: "Pièce1" }).click();
  await expect(bubble).toContainText("Visite en pause");
  await bubble.getByRole("button", { name: "Revenir à la pièce" }).click();
  await expect(bubble).toContainText("Ouvrir une esquisse");

  // Extrude before Sketch: the sketch opens directly, the tour follows.
  await page.locator('.ribbon-btn[data-cmd="part.extrude"]').click();
  await expect(bubble).toContainText(/Choisir l'outil Rectangle|Tracer le rectangle/);
  await bubble.getByRole("button", { name: "Quitter la visite" }).click();
  await expect(bubble).toHaveCount(0);

  expect(errors).toEqual([]);
});
