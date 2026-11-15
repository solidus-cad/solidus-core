import { expect, test } from "@playwright/test";

const open = async (page: import("@playwright/test").Page, prompt = false) => {
  await page.addInitScript((p) => {
    // Also runs in the isolated plugin iframe, which has no storage access.
    if (window !== window.top) return;
    // Once only: a reload keeps the user's choices.
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
    if (p) localStorage.setItem("cad.plugins.prompt", "1");
  }, prompt);
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
};

test("plugins: Plugins menu disables a module, the choice is kept", async ({ page }) => {
  await open(page);
  const tab = page.locator(".ribbon-tabs").getByRole("tab", { name: "Tôlerie" });
  await expect(tab).toBeVisible();

  await page.locator(".menus").getByRole("button", { name: "Plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins" });
  await dialog.getByRole("checkbox", { name: /Tôlerie/ }).uncheck();
  await dialog.getByRole("button", { name: "Fermer" }).click();
  await expect(tab).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  await expect(page.locator(".ribbon-tabs").getByRole("tab", { name: "Tôlerie" })).toHaveCount(0);
});

test("plugins: first-run wizard", async ({ page }) => {
  await open(page, true);
  const dialog = page.getByRole("dialog", { name: "Bienvenue : choisissez vos modules" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Tôlerie/ }).uncheck();
  await dialog.getByRole("button", { name: "Valider" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".ribbon-tabs").getByRole("tab", { name: "Tôlerie" })).toHaveCount(0);

  // Does not show again.
  await page.reload();
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  await expect(page.getByRole("dialog", { name: "Bienvenue : choisissez vos modules" })).toHaveCount(0);
});
