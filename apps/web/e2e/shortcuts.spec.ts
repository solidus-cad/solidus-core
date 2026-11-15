import { expect, test, type Page } from "@playwright/test";

const row = (page: Page, label: string) => page.locator(".keys-row").filter({ has: page.getByText(label, { exact: true }) });

test("shortcuts: common setting for workbenches, local override, conflict, persistence", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("init")) {
      localStorage.clear();
      sessionStorage.setItem("init", "1");
    }
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });

  // Settings > Keyboard shortcuts…
  await page.getByRole("button", { name: "Paramètres", exact: true }).click();
  await page.getByRole("button", { name: "Raccourcis clavier…" }).click();
  const dialog = page.getByRole("dialog", { name: "Raccourcis clavier" });
  await expect(dialog).toBeVisible();

  // Common: the rectangle changes from R to K, for all workbenches.
  await dialog.getByRole("button", { name: "Commun aux ateliers" }).click();
  const rect = row(page, "Rectangle");
  await expect(rect.locator("kbd")).toHaveText(["R"]);
  await rect.getByRole("button", { name: "Ajouter un raccourci" }).click();
  await page.keyboard.press("k");
  await expect(rect.locator(".keys-chip kbd")).toHaveText(["R", "K"]); // single key: validated after 0.8 s
  await rect.locator(".keys-chip", { hasText: "R" }).getByRole("button", { name: "Retirer ce raccourci" }).click();
  await expect(rect.locator(".keys-chip kbd")).toHaveText(["K"]);

  // Blocking conflict: L is already Line (common) → replacement proposed.
  await row(page, "Cercle").getByRole("button", { name: "Ajouter un raccourci" }).click();
  await page.keyboard.press("l");
  await expect(dialog.locator(".keys-notice.error")).toContainText("est déjà utilisé par Ligne (Commun aux ateliers)");
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();

  // The sketch follows the common setting (badge) and can override it locally.
  await dialog.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(row(page, "Rectangle").locator(".keys-badge")).toBeVisible();
  await expect(row(page, "Rectangle").locator(".keys-chip kbd")).toHaveText(["K"]);
  await page.screenshot({ path: "test-results/shortcuts-dialog.png" });
  await dialog.getByRole("button", { name: "Fermer" }).click();
  await expect(dialog).toHaveCount(0);

  // In sketch mode, K activates the rectangle; R no longer does anything.
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  // Ribbon button selected by its label (with a video preview it has no `title` tooltip).
  const rectBtn = page.locator(".ribbon-btn").filter({ has: page.getByText("Rectangle", { exact: true }) });
  await page.keyboard.press("k");
  await expect(rectBtn).toHaveClass(/pressed/);
  await page.keyboard.press("s");
  await expect(rectBtn).not.toHaveClass(/pressed/);
  await page.keyboard.press("r");
  await expect(rectBtn).not.toHaveClass(/pressed/);

  // Reload: setting kept (shortcuts.json), K still activates the rectangle.
  await page.reload();
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  await page.keyboard.press("k");
  await expect(rectBtn).toHaveClass(/pressed/);
  // The video preview label shows the configured shortcut.
  await expect(rectBtn).toHaveAttribute("data-preview-label", "Rectangle (K)");
  expect(errors).toEqual([]);
});
