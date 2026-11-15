import { expect, test } from "@playwright/test";

test("views list: the 12 views at 45° and the 8 isometric views", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });

  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();

  await page.locator(".view-tools").getByRole("button", { name: "Vues" }).click();
  const items = page.locator(".menu-popup.context button");
  await expect(items).toHaveCount(20);
  await expect(items.filter({ hasText: "Avant + Droite + Dessus" })).toHaveCount(1);
  const before = await page.locator(".canvas-host canvas").first().screenshot();
  await page.locator(".menu-popup.context").getByRole("button", { name: "Arrière + Gauche", exact: true }).click();
  await expect(items).toHaveCount(0);
  await page.waitForTimeout(600);
  expect((await page.locator(".canvas-host canvas").first().screenshot()).equals(before)).toBe(false);
  expect(errors).toEqual([]);
});
