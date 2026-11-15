import { expect, test } from "@playwright/test";

test("sheet metal: base sheet, flange picked in the view, flat pattern", async ({ page }) => {
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

  await page.getByRole("tab", { name: "Tôlerie", exact: true }).click();
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  const box = (await page.locator(".viewport").boundingBox())!;
  const o = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Rectangle from the origin.
  await page.keyboard.press("r");
  await page.mouse.click(o.x, o.y);
  await page.mouse.move(o.x + 60, o.y - 40);
  await page.mouse.click(o.x + 120, o.y - 80);
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();

  // 2 mm sheet.
  await page.getByRole("button", { name: "Tôle de base" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Prêt");
  const volumeOf = async () => Number(/Volume ([\d,]+) cm³/.exec((await status.textContent())!)![1]!.replace(",", "."));
  await expect.poll(volumeOf).toBeGreaterThan(0);
  const plate = await volumeOf();

  // Flange: edge picked in the view.
  await page.getByRole("button", { name: "Bord tombé" }).click();
  const panel = page.locator(".property-panel");
  await expect(panel).toContainText("0 arête(s) désignée(s)");
  const x = box.x + box.width / 2;
  let found = false;
  for (let y = box.y + 60; y < box.y + box.height - 60 && !found; y += 3) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    found = (await panel.textContent())!.includes("1 arête(s)");
  }
  expect(found).toBe(true);
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Prêt");
  await expect(page.locator(".tree-row.error")).toHaveCount(0);
  await expect.poll(volumeOf).toBeGreaterThan(plate);
  await page.getByRole("button", { name: "Affichage" }).click();
  await page.getByRole("button", { name: "Vue isométrique" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT_SM1 ?? "test-results/sheetmetal.png" });

  // Flat pattern: one bend, preview and DXF export.
  await page.getByRole("button", { name: "Développé DXF" }).click();
  const dialog = page.getByRole("dialog", { name: "Développé" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("flat-bends")).toHaveText("1");
  await expect(dialog.locator(".flat-bend")).toHaveCount(1);
  await expect(dialog).toContainText("HAUT 90°");
  await page.screenshot({ path: process.env.SHOT_SM2 ?? "test-results/sheetmetal-flat.png" });
  await dialog.getByRole("button", { name: "OK" }).click();

  // Flattened in the tree: same volume.
  const folded = await volumeOf();
  await page.getByRole("button", { name: "Mise à plat" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Prêt");
  await expect.poll(volumeOf).toBeCloseTo(folded, 0);
  await page.screenshot({ path: process.env.SHOT_SM3 ?? "test-results/sheetmetal-flattened.png" });
  expect(errors).toEqual([]);
});
