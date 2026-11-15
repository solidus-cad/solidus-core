import { expect, test } from "@playwright/test";

test("angular dimension to an edge of the model (external reference, not imported)", async ({ page }) => {
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

  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  // "Dimensions" and "Tools" groups stacked over several lines.
  await expect(page.locator(".ribbon-buttons.stacked", { hasText: "Cote angulaire" })).toHaveCount(1);
  await expect(page.locator(".ribbon-buttons.stacked", { hasText: "Ajuster" })).toHaveCount(1);

  const o = await page.evaluate(() => document.querySelector(".sk-point.origin")!.getBoundingClientRect().toJSON() as DOMRect);
  const ox = o.x + o.width / 2;
  const oy = o.y + o.height / 2;
  // Inclined line above the box.
  await page.keyboard.press("l");
  await page.mouse.click(ox + 60, oy - 120);
  await page.mouse.click(ox + 160, oy - 60);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".sk-curve")).toHaveCount(1);

  // Angular dimension: the line, then the front edge of the box (y = 0), which is not in the sketch.
  await page.getByRole("button", { name: "Cote angulaire" }).click();
  await page.mouse.click(ox + 110, oy - 90);
  await page.mouse.click(ox + 40, oy);
  await expect(page.locator(".sk-curve.external")).toHaveCount(1);
  const input = page.locator(".sk-dim-input");
  await expect(input).toBeVisible();
  await input.fill("45");
  await input.press("Enter");
  await expect(page.locator(".sk-dim-label", { hasText: "45°" })).toBeVisible();
  await expect(page.locator(".sk-dim-arc")).toHaveCount(1);

  // The external reference disappears with the dimension that uses it.
  await page.keyboard.press("Escape");
  await page.locator(".sk-dim-label", { hasText: "45°" }).click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".sk-dim-label")).toHaveCount(0);
  await expect(page.locator(".sk-curve.external")).toHaveCount(0);
  await expect(page.locator(".sk-curve")).toHaveCount(1);

  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await expect(status).toContainText("Prêt");
  await expect(page.locator(".tree-row.error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("dimension to the center of a circular edge of the model", async ({ page }) => {
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
  // Hole of radius 15 at the center of the box (100 × 60).
  await page.getByRole("button", { name: "Cylindre" }).click();
  const panel = page.locator(".property-panel");
  await panel.getByLabel("Opération").selectOption("cut");
  await panel.getByLabel("Position X").fill("50");
  await panel.getByLabel("Position Y").fill("30");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).not.toContainText("Volume 240 cm³");

  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  const o = await page.evaluate(() => document.querySelector(".sk-point.origin")!.getBoundingClientRect().toJSON() as DOMRect);
  const ox = o.x + o.width / 2;
  const oy = o.y + o.height / 2;
  // View scale: horizontal line of 200 px below the box, dimensioned.
  await page.keyboard.press("l");
  await page.mouse.click(ox, oy + 60);
  await page.mouse.click(ox + 200, oy + 60);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.mouse.click(ox + 100, oy + 60);
  await page.getByRole("button", { name: "Cote intelligente", exact: true }).click();
  const input = page.locator(".sk-dim-input");
  const mmPerPx = Number(await input.inputValue()) / 200;
  await input.press("Escape");
  const toPx = (x: number, y: number) => ({ x: ox + x / mmPerPx, y: oy - y / mmPerPx });

  // Hover over the hole edge: its center appears, then dimension it relative to the left point of the line.
  await page.getByRole("button", { name: "Cote horizontale" }).click();
  const edge = toPx(65, 30);
  await page.mouse.move(edge.x, edge.y);
  await expect(page.locator(".sk-ext-center")).toHaveCount(1);
  const c = toPx(50, 30);
  await page.mouse.click(ox, oy + 60);
  await page.mouse.click(c.x, c.y);
  await expect(page.locator(".sk-point.external")).toHaveCount(1);
  // The left point is snapped to the vertical axis (x already fixed): the dimension is added as a reference dimension, in parentheses.
  await expect(page.locator(".sk-dim-label", { hasText: /^\(50\)$/ })).toBeVisible();
  expect(errors).toEqual([]);
});
