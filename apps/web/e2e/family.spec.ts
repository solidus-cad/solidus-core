import { expect, test } from "@playwright/test";

test("part family: the active configuration drives the parameters", async ({ page }) => {
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

  // Parameter P1 = 100 used as the box width.
  await page.getByRole("button", { name: "+ Ajouter un paramètre" }).click();
  await page.getByLabel("Expression").fill("100");
  await page.getByLabel("Expression").press("Enter");
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.locator(".property-panel").getByLabel("Largeur (X)").fill("P1");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");

  // Family: two configurations, the second with P1 = 50.
  await page.getByRole("button", { name: /Famille de pièces/ }).click();
  await page.getByRole("button", { name: "+ Créer depuis les paramètres" }).click();
  await page.getByRole("button", { name: "+ Configuration", exact: true }).click();
  const cell = page.locator(".family-table tbody tr").nth(1).getByLabel("P1");
  await cell.fill("50");
  await cell.press("Enter");
  await page.getByLabel("Configuration active").selectOption({ index: 1 });
  await expect(status).toContainText("Volume 120 cm³");
  await page.getByLabel("Configuration active").selectOption({ index: 0 });
  await expect(status).toContainText("Volume 240 cm³");
  expect(errors).toEqual([]);
});
