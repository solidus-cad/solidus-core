import { expect, test } from "@playwright/test";

test("assembly: insertion, bill of materials, in-context editing", async ({ page }) => {
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

  // New assembly from the ribbon tab.
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  await expect(page.locator(".asm-name")).toHaveValue("Assemblage1");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");
  await expect(page.locator(".tree-row:not(.mate-row)", { hasText: "Pièce1 <1>" })).toContainText("📌");
  // The base part has a "Fixe" constraint; the second instance is free.
  await expect(page.locator(".mate-row", { hasText: "Fixe · Pièce1 <1>" })).toBeVisible();
  await expect(page.locator(".mate-row", { hasText: "Pièce1 <2>" })).toHaveCount(0);

  // Bill of materials: one row, quantity 2.
  await page.getByRole("button", { name: "Nomenclature" }).click();
  const rows = page.locator(".bom-table tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("td").nth(4)).toHaveText("2");
  await page.getByRole("button", { name: "OK" }).click();

  // Selection, copy and undo.
  await page.locator(".tree-row:not(.mate-row)", { hasText: "Pièce1 <2>" }).click();
  await page.getByRole("button", { name: "Copier" }).click();
  await expect(status).toContainText("3 occurrence(s)");
  await page.keyboard.press("Control+z");
  await expect(status).toContainText("2 occurrence(s)");
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT_ASM ?? "test-results/assembly.png" });

  // In-context editing: the part opens, then returns to the assembly.
  await page.locator(".tree-row:not(.mate-row)", { hasText: "Pièce1 <1>" }).dblclick();
  await expect(page.getByText("Édition d'une pièce de l'assemblage")).toBeVisible();
  await expect(status).toContainText("Volume 240 cm³");
  await page.getByRole("button", { name: "↩ Retour à l'assemblage" }).click();
  await expect(status).toContainText("2 occurrence(s)");
  expect(errors).toEqual([]);
});
