import { expect, test } from "@playwright/test";

test("assembly: sub-assembly inserted, rigid then flexible", async ({ page }) => {
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

  // Sub-assembly: two occurrences of the part.
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");

  // Assembly: the inserted sub-assembly as a single occurrence.
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await page.getByRole("button", { name: "+ Assemblage" }).click();
  await expect(page.locator(".asm-name")).toHaveValue("Assemblage2");
  await page.getByRole("button", { name: "Insérer" }).click();
  await expect(page.getByText("Sous-assemblages")).toBeVisible();
  await expect(page.locator(".insert-row", { hasText: "Assemblage2" })).toHaveCount(0); // no loop
  await page.locator(".insert-row", { hasText: "Assemblage1" }).click();
  await expect(status).toContainText("1 occurrence(s)");
  // Occurrence row (not the "Fixe · Assemblage1 <1>" constraint in the Contraintes section).
  const occ = page.locator(".tree-row:not(.mate-row)", { hasText: "Assemblage1 <1>" });
  await expect(occ).toContainText("⧉");
  await expect(occ).toContainText("▣");
  await expect(page.locator(".sub-row")).toHaveCount(2);

  // Expanded bill of materials: the part counts twice.
  await page.getByRole("button", { name: "Nomenclature" }).click();
  await expect(page.locator(".bom-table tbody tr").first().locator("td").nth(4)).toHaveText("2");
  await page.getByRole("button", { name: "OK" }).click();

  // Rigid: clicking a part selects the whole occurrence.
  await page.locator(".sub-row", { hasText: "Pièce1 <2>" }).click();
  await expect(occ).toHaveClass(/active/);

  // Flexible: the part is selected on its own.
  await occ.click({ button: "right" });
  await page.getByRole("button", { name: "Rendre flexible" }).click();
  await expect(occ).toContainText("⇄");
  await page.locator(".sub-row", { hasText: "Pièce1 <2>" }).click();
  await expect(page.locator(".sub-row", { hasText: "Pièce1 <2>" })).toHaveClass(/active/);
  await expect(occ).not.toHaveClass(/active/);

  await page.keyboard.press("Control+z");
  await expect(occ).toContainText("▣");
  expect(errors).toEqual([]);
});
