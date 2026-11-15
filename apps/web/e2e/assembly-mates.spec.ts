import { expect, test } from "@playwright/test";

test("assembly: constraints on part planes", async ({ page }) => {
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
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");

  // Parallel XZ planes, then XY planes at 15 mm: the base planes of both parts are offered.
  const planeSelect = page.locator("label.field", { hasText: "…ou un plan de pièce" }).locator("select");
  await page.getByRole("button", { name: "Parallèle" }).click();
  await planeSelect.selectOption({ label: "Pièce1 <1> — Plan XZ" });
  await expect(page.getByText("Premier élément : Pièce1 <1> (plan)")).toBeVisible();
  // The occurrence already designated is no longer offered.
  await expect(planeSelect.locator("option", { hasText: "Pièce1 <1> — Plan XY" })).toHaveCount(0);
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XZ" });
  await expect(page.locator(".mate-row", { hasText: "Parallèle · Pièce1 <1> / Pièce1 <2>" })).toBeVisible();
  await expect(page.getByText("4 degré(s) de liberté")).toBeVisible();

  await page.getByRole("button", { name: "Distance" }).click();
  await page.locator("label.field", { hasText: "Valeur (mm)" }).locator("input").fill("15");
  await planeSelect.selectOption({ label: "Pièce1 <1> — Plan XY" });
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XY" });
  await expect(page.locator(".mate-row", { hasText: "Distance · Pièce1 <1> / Pièce1 <2>" })).toBeVisible();
  // X and Y translations remain; no half turn (same-direction planes are kept).
  await expect(page.getByText("2 degré(s) de liberté")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT_MATES ?? "test-results/assembly-mates.png" });
  expect(errors).toEqual([]);
});

test("assembly: concentric constraint with rotation locked", async ({ page }) => {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem("cad.lang", "fr"); });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  await page.getByRole("button", { name: "Cylindre" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 2; i++) { await page.getByRole("button", { name: "Insérer" }).click(); await page.locator(".insert-row", { hasText: "Pièce1" }).click(); }
  await expect(status).toContainText("2 occurrence(s)");
  await page.waitForTimeout(800);
  // Concentric with rotation locked on the cylindrical faces: the translation along the axis remains.
  await page.getByRole("button", { name: "Concentrique" }).click();
  await page.getByLabel("Bloquer la rotation").check();
  await page.mouse.click(555, 470); await page.waitForTimeout(300);
  await page.mouse.click(870, 650); await page.waitForTimeout(800);
  await expect(page.locator(".mate-row", { hasText: "Concentrique 🔒" })).toBeVisible();
  await expect(page.getByText("1 degré(s) de liberté")).toBeVisible();
  // Context menu: free, then lock again.
  await page.locator(".mate-row", { hasText: "Concentrique" }).click({ button: "right" });
  await page.getByText("Libérer la rotation").click();
  await expect(page.getByText("2 degré(s) de liberté")).toBeVisible();
  await page.locator(".mate-row", { hasText: "Concentrique" }).click({ button: "right" });
  await page.getByText("Bloquer la rotation").click();
  await expect(page.getByText("1 degré(s) de liberté")).toBeVisible();
});
