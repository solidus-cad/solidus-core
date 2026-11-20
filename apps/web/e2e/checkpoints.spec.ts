import { expect, test, type Page } from "@playwright/test";

/** Document tab matched by its exact name ("Pièce1", not "Pièce1 (v2)"). */
const docTab = (page: Page, name: string) => page.locator(".doc-tab").filter({ has: page.locator(".doc-tab-name", { hasText: new RegExp(`^${name.replace(/[()]/g, "\\$&")}$`) }) });

/** Creates a checkpoint of the tab's document via right-click. */
async function checkpoint(page: Page, tab: string, comment: string) {
  await docTab(page, tab).click({ button: "right" });
  await page.locator(".menu-popup.context").getByRole("button", { name: "Créer un checkpoint…" }).click();
  const dialog = page.locator(".checkpoint-dialog");
  await dialog.locator("textarea").fill(comment);
  await dialog.getByRole("button", { name: "Créer" }).click();
  await expect(dialog).toHaveCount(0);
}

/** Expands the document's versions (left panel section) via right-click on its tab. */
async function versions(page: Page, tab: string) {
  await docTab(page, tab).click({ button: "right" });
  await page.locator(".menu-popup.context").getByRole("button", { name: "Versions…" }).click();
  return page.locator(".version-panel");
}

/** Action from a version's context menu. */
async function versionMenu(page: Page, panel: ReturnType<Page["locator"]>, text: string, action: string) {
  await panel.locator(".version-list li", { hasText: text }).click({ button: "right" });
  await page.locator(".menu-popup.context").getByRole("button", { name: action }).click();
}

test("checkpoints: versions of a part, rollback, branch", async ({ page }) => {
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

  await checkpoint(page, "Pièce1", "pièce vide");
  // A checkpoint not saved to the file marks the document as modified.
  await expect(docTab(page, "Pièce1").locator(".dirty")).toHaveCount(1);
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  await checkpoint(page, "Pièce1", "ajout de la boîte");

  // Versions are collapsed by default in the left panel.
  const panel = page.locator(".version-panel");
  await expect(panel.locator(".count")).toHaveText("v2");
  await expect(panel.locator(".version-list")).toHaveCount(0);

  // Back to v1: the box disappears, v2 stays in the list.
  await versions(page, "Pièce1");
  const rows = panel.locator(".version-list li");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("v2");
  await expect(rows.first()).toContainText("ajout de la boîte");
  await panel.getByRole("button", { name: "Restaurer v1" }).click();
  await expect(status).not.toContainText("240 cm³");
  await expect(panel.locator(".version-list li.head")).toContainText("v1");
  await expect(rows).toHaveCount(2);

  // Ctrl+Z undoes the restore; the next checkpoint starts from v1 (branch).
  await page.keyboard.press("Control+z");
  await expect(status).toContainText("Volume 240 cm³");
  await checkpoint(page, "Pièce1", "variante");
  await expect(rows.first()).toContainText("v3");
  await expect(rows.first()).toContainText("issue de v1");

  // Click on a version: preview tab, replaced by the next preview.
  const tabs = page.locator(".doc-tab");
  await rows.filter({ hasText: "ajout de la boîte" }).locator(".version-comment").click();
  await expect(page.locator(".doc-tab.active.preview")).toContainText("Pièce1 (v2)");
  await expect(status).toContainText("Volume 240 cm³");
  await expect(tabs).toHaveCount(2);
  await versions(page, "Pièce1");
  await versionMenu(page, panel, "pièce vide", "Aperçu");
  await expect(page.locator(".doc-tab.active.preview")).toContainText("Pièce1 (v1)");
  await expect(tabs).toHaveCount(2);
  await expect(status).not.toContainText("240 cm³");

  // Deletion of v2 (confirmed in the row): v3 is reattached to v1.
  await versions(page, "Pièce1");
  await versionMenu(page, panel, "ajout de la boîte", "Supprimer");
  await panel.getByRole("button", { name: "Supprimer", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("v3");

  // Open a copy of v1: new tab, current document intact.
  await versionMenu(page, panel, "pièce vide", "Ouvrir une copie");
  await expect(page.locator(".doc-tab.active")).toContainText("Pièce1 (v1)");
  await expect(page.locator(".doc-tab.active.preview")).toHaveCount(0);
  await docTab(page, "Pièce1").click();
  await expect(status).toContainText("Volume 240 cm³");
  expect(errors).toEqual([]);
});

test("checkpoints: assembly restored with document selection", async ({ page }) => {
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
  await checkpoint(page, "Assemblage1", "deux occurrences");

  await page.locator(".tree-row", { hasText: "Pièce1 <2>" }).click();
  await page.getByRole("button", { name: "Dupliquer" }).click();
  await expect(status).toContainText("3 occurrence(s)");

  const panel = await versions(page, "Assemblage1");
  await panel.getByRole("button", { name: "Restaurer v1" }).click();
  const dialog = page.locator(".checkpoint-dialog");
  // Document selection: the assembly changed (checked), the part did not (unchecked).
  const items = dialog.locator(".checkpoint-items li");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("modifié depuis");
  await expect(items.first().locator("input")).toBeChecked();
  await expect(items.nth(1)).toContainText("identique");
  await expect(items.nth(1).locator("input")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Restaurer" }).click();
  await expect(status).toContainText("2 occurrence(s)");

  await page.keyboard.press("Control+z");
  await expect(status).toContainText("3 occurrence(s)");
  expect(errors).toEqual([]);
});
