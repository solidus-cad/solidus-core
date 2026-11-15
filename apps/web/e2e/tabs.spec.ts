import { expect, test } from "@playwright/test";

test("tabs: several parts open, history kept, closing", async ({ page }) => {
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

  // New part from the "+" tab button.
  const tabs = page.locator(".doc-tab");
  await page.getByRole("button", { name: "Nouveau document" }).click();
  await page.getByRole("button", { name: "Nouvelle pièce" }).click();
  await expect(tabs).toHaveCount(2);
  await expect(page.locator(".doc-tab.active")).toContainText("Pièce2");
  await expect(status).not.toContainText("240 cm³");

  // Give the history of the inactive part time to compress, then return to it: undo still works.
  await page.waitForTimeout(2500);
  await tabs.filter({ hasText: "Pièce1" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  await page.keyboard.press("Control+z");
  await expect(status).not.toContainText("240 cm³");
  await page.keyboard.press("Control+y");
  await expect(status).toContainText("Volume 240 cm³");

  // Middle click: closes the tab.
  await tabs.filter({ hasText: "Pièce2" }).click({ button: "middle" });
  await expect(tabs).toHaveCount(1);
  await expect(page.locator(".doc-tab.active")).toContainText("Pièce1");

  expect(errors).toEqual([]);
});

test("tabs: closing a modified document offers to save it", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  const tabs = page.locator(".doc-tab");

  // A new, unmodified part closes without a question.
  await page.getByRole("button", { name: "Nouveau document" }).click();
  await page.getByRole("button", { name: "Nouvelle pièce" }).click();
  await expect(tabs.filter({ hasText: "Pièce2" }).locator(".dirty")).toHaveCount(0);
  await page.getByRole("button", { name: "Fermer Pièce2" }).click();
  await expect(tabs).toHaveCount(1);

  // Modified: closing asks to save.
  await page.getByRole("button", { name: "Nouveau document" }).click();
  await page.getByRole("button", { name: "Nouvelle pièce" }).click();
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  const pc2 = tabs.filter({ hasText: "Pièce2" });
  await expect(pc2.locator(".dirty")).toHaveCount(1);

  const dialog = page.getByRole("dialog", { name: "Enregistrer les modifications ?" });
  await page.getByRole("button", { name: "Fermer Pièce2" }).click();
  await expect(dialog).toContainText("« Pièce2 » a été modifié");
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tabs).toHaveCount(2);

  await pc2.click({ button: "middle" });
  await dialog.getByRole("button", { name: "Ne pas enregistrer" }).click();
  await expect(tabs).toHaveCount(1);
});

