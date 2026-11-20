import { expect, test } from "@playwright/test";

test("assembly: copy, cut and paste of occurrences (same assembly, other tab)", async ({ page }) => {
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
  const row = (name: string) => page.locator(".tree-row:not(.mate-row)", { hasText: name });

  // Ctrl+C / Ctrl+V in the same assembly: a new numbered occurrence, selected.
  await row("Pièce1 <2>").click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(status).toContainText("3 occurrence(s)");
  await expect(row("Pièce1 <3>")).toHaveClass(/active/);
  await page.keyboard.press("Control+z");
  await expect(status).toContainText("2 occurrence(s)");

  // Ctrl+X then Ctrl+V: the occurrence comes back with its name.
  await row("Pièce1 <2>").click();
  await page.keyboard.press("Control+x");
  await expect(status).toContainText("1 occurrence(s)");
  await expect(row("Pièce1 <2>")).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(status).toContainText("2 occurrence(s)");
  await expect(row("Pièce1 <2>")).toHaveCount(1);

  // Context menu "Copier", then paste into another assembly tab: first body, fixed.
  await row("Pièce1 <1>").click({ button: "right" });
  await page.getByRole("button", { name: "Copier", exact: true }).click();
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await page.getByRole("button", { name: "+ Assemblage" }).click();
  await expect(page.locator(".asm-name")).toHaveValue("Assemblage2");
  await page.locator(".tree").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+v");
  await expect(status).toContainText("1 occurrence(s)");
  await expect(row("Pièce1 <1>")).toContainText("📌");

  // Context menu "Coller" on an occurrence.
  await row("Pièce1 <1>").click({ button: "right" });
  await page.getByRole("button", { name: "Coller", exact: true }).click();
  await expect(status).toContainText("2 occurrence(s)");

  // A subassembly is not pasted into an assembly it already contains.
  await page.getByRole("button", { name: "Insérer" }).click();
  await page.locator(".insert-row", { hasText: "Assemblage1" }).click();
  await expect(status).toContainText("3 occurrence(s)");
  await row("Assemblage1 <1>").click();
  await page.keyboard.press("Control+c");
  await page.locator(".doc-tab", { hasText: "Assemblage1" }).click();
  await expect(page.locator(".asm-name")).toHaveValue("Assemblage1");
  await page.keyboard.press("Control+v");
  await expect(page.getByText("il contient déjà cet assemblage")).toBeVisible();
  await expect(status).toContainText("2 occurrence(s)");
  expect(errors).toEqual([]);
});
