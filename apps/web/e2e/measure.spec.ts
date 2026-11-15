import { expect, test } from "@playwright/test";

test("Measure workbench: point to point, volume and mass (part and assembly)", async ({ page }) => {
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

  // Point to point: two clicks on the part.
  await page.getByRole("tab", { name: "Outils", exact: true }).click();
  const panel = page.locator(".measure-panel");
  await expect(panel).toContainText("Cliquez un premier point");
  const canvas = page.locator(".canvas-host canvas");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 40, cy - 10);
  await page.mouse.click(cx - 40, cy - 10);
  await expect(panel).toContainText("Cliquez le second point");
  await page.mouse.move(cx + 40, cy + 10);
  await page.mouse.click(cx + 40, cy + 10);
  await expect(panel).toContainText("Distance");
  // Distance label (the ΔX, ΔY, ΔZ offsets are .axis labels).
  await expect(page.locator(".measure-label:not(.axis)")).toContainText("mm");
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_DIST ?? "test-results/measure-distance.png" });
  await page.keyboard.press("Escape");
  await expect(panel).toContainText("Cliquez un premier point");

  // Volume and mass: part without a material is flagged.
  await page.getByRole("button", { name: "Volume et masse" }).click();
  await expect(panel).toContainText("240,00 cm³");
  await expect(panel.getByRole("alert")).toContainText("Aucun matériau affecté");
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_MASS ?? "test-results/measure-mass-part.png" });

  // Assembly: parts without a material are flagged, a material is assigned from the panel, then selection only.
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  await expect(panel).toBeHidden();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");
  await page.getByRole("tab", { name: "Outils", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("2 pièce(s) sans matériau");
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_ASM_MISSING ?? "test-results/measure-mass-asm-missing.png" });
  await panel.getByLabel("Affecter un matériau… Pièce1").selectOption("Acier S235");
  await expect(panel.getByRole("alert")).toBeHidden();
  await expect(panel).toContainText("3,768 kg");
  // Center of gravity and center of volume, in coordinates and in the view; inertia of the whole.
  await expect(panel).toContainText("Centre de gravité");
  await expect(panel).toContainText("Centre du volume");
  await expect(page.locator(".centre-label.cog")).toHaveText("CdG");
  await expect(page.locator(".centre-label.cov")).toHaveText("CdV");
  await expect(panel.locator(".meas-inertia-grid")).toContainText("Iyz");
  await page.locator(".tree-row", { hasText: "Pièce1 <2>" }).click();
  await panel.getByRole("button", { name: "Sélection" }).click();
  await expect(panel).toContainText("1,884 kg");
  await panel.getByRole("button", { name: "Tout l'assemblage" }).click();
  await expect(panel).toContainText("3,768 kg");
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_ASM_MASS ?? "test-results/measure-mass-asm.png" });
  expect(errors).toEqual([]);
});

test("Measure workbench: diameter and radius of a cylindrical face", async ({ page }) => {
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

  // Cylinder R15 × 40, front view: the center of the view falls on the cylindrical face.
  await page.getByRole("button", { name: "Cylindre" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume");
  await page.getByRole("button", { name: "Affichage" }).click();
  await page.locator(".menu-popup button", { hasText: "Vue de face" }).click();
  await page.waitForTimeout(600);

  await page.getByRole("tab", { name: "Outils", exact: true }).click();
  await page.getByRole("button", { name: "Diamètre / rayon" }).click();
  const panel = page.locator(".measure-panel");
  await expect(panel).toContainText("Cliquez une arête circulaire");
  const box = (await page.locator(".canvas-host canvas").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx + 3, cy + 5);
  await page.mouse.click(cx + 3, cy + 5);
  await expect(panel).toContainText("face cylindrique");
  await expect(panel).toContainText("Ø 30,00 mm");
  await expect(panel).toContainText("R 15,00 mm");
  await expect(page.locator(".measure-label")).toContainText("Ø 30,00 mm");
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_CIRCLE ?? "test-results/measure-circle.png" });
  await page.keyboard.press("Escape");
  await expect(panel).toContainText("Cliquez une arête circulaire");
  expect(errors).toEqual([]);
});

test("Measure workbench: inertia and center of gravity of a part", async ({ page }) => {
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

  await page.getByRole("tab", { name: "Outils", exact: true }).click();
  await page.getByRole("button", { name: "Volume et masse" }).click();
  const panel = page.locator(".measure-panel");
  await expect(panel).toContainText("affectez un matériau");
  await panel.getByLabel("Affecter un matériau… Pièce1").selectOption("Acier S235");
  await expect(panel).toContainText("1,884 kg");

  // Box 100 × 60 × 40 in steel: m = 1.884 kg, Ixx = m(60² + 40²)/12, Iyy = m(100² + 40²)/12, zero products of inertia.
  const cell = (label: string) => panel.locator(".meas-inertia-grid div", { hasText: label }).locator("dd");
  await expect(cell("Ixx")).toHaveText("816,40");
  await expect(cell("Iyy")).toHaveText("1 821,20".replace(" ", " "));
  await expect(cell("Ixy")).toHaveText("0,00");
  await expect(panel).toContainText("(50,00 ; 30,00 ; 20,00)");
  await expect(page.locator(".centre-label.cog")).toHaveText("CdG");
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_INERTIA ?? "test-results/measure-inertia.png" });

  // At the origin: Huygens theorem, Ixx + m(30² + 20²).
  await panel.getByRole("button", { name: "À l'origine" }).click();
  await expect(cell("Ixx")).toHaveText("3 265,60".replace(" ", " "));
  expect(errors).toEqual([]);
});
