import { expect, test } from "@playwright/test";

test("models a parametric part end to end", async ({ page }) => {
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

  // Box 100 × 60 × 40
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");

  // Global parameter used by the hole
  await page.getByRole("button", { name: "+ Ajouter un paramètre" }).click();
  await page.getByLabel("Expression").fill("20");
  await page.getByLabel("Expression").press("Enter");

  // Cylinder as a cut, radius driven by P1
  await page.getByRole("button", { name: "Cylindre" }).click();
  const panel = page.locator(".property-panel");
  await panel.getByLabel("Opération").selectOption("cut");
  await panel.getByLabel("Rayon").fill("P1 / 2");
  await expect(panel).toContainText("= 10");
  await panel.getByLabel("Position X").fill("50");
  await panel.getByLabel("Position Y").fill("30");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 227,43 cm³");

  // Undo / redo
  await page.keyboard.press("Control+z");
  await expect(status).toContainText("Volume 240 cm³");
  await page.keyboard.press("Control+y");
  await expect(status).toContainText("Volume 227,43 cm³");

  // An impossible feature is reported without losing the part
  await page.getByRole("button", { name: "Congé" }).click();
  await panel.getByLabel("Rayon").fill("500");
  await expect(page.locator(".panel-error")).toBeVisible();
  await expect(status).toContainText("Volume 227,43 cm³");
  await panel.getByLabel("Rayon").fill("2");
  await expect(page.locator(".panel-error")).toBeHidden();
  await page.getByRole("button", { name: "✓ Valider" }).click();

  // Resume bar: go back before the cylinder
  await page.locator(".tree-row", { hasText: "Boîte1" }).click({ button: "right" });
  await page.getByRole("button", { name: "Reprendre ici" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  await page.locator(".tree-row", { hasText: "Boîte1" }).click({ button: "right" });
  await page.getByRole("button", { name: "Reprendre à la fin" }).click();
  await expect(status).toContainText("Prêt");
  await expect(status).not.toContainText("Volume 240 cm³");

  // Select a face in the view
  await page.mouse.move(800, 450);
  await page.mouse.click(800, 450);
  await page.screenshot({ path: process.env.SHOT ?? "test-results/part.png" });

  expect(errors).toEqual([]);
});
