import { expect, test } from "@playwright/test";

test("slot started without a sketch: plane, path, then feature", async ({ page }) => {
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

  // Box 100 × 60 × 40 (selected in the tree: no sketch selected).
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");

  // Slot: waiting for the sketch plane, chosen in the tree.
  await page.getByRole("button", { name: "Oblong", exact: true }).click();
  await expect(status).toContainText("Cliquez une face plane ou un plan");
  await expect(page.locator(".sketch-overlay")).toHaveCount(0);
  // Base planes: "Références" section of the tree, collapsed by default (and on each tree rebuild).
  const xy = page.locator(".tree-row", { hasText: "Dessus (XY)" });
  const showPlanes = async () => {
    if ((await xy.count()) === 0) await page.locator(".tree-section-title", { hasText: "Références" }).click();
    await expect(xy).toBeVisible();
  };
  await showPlanes();
  await xy.click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();

  // Slot axis: line from (30, 30) to (70, 30).
  const box = (await page.locator(".viewport").boundingBox())!;
  const o = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.keyboard.press("l");
  await page.mouse.click(o.x + 30, o.y - 30);
  await page.mouse.click(o.x + 70, o.y - 30);
  await page.keyboard.press("Escape");
  await expect(page.locator(".sk-curve")).toHaveCount(1);
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();

  // The feature opens on the drawn sketch; XY plane under the box: cut toward +Z.
  const panel = page.locator(".property-panel");
  await expect(panel.getByLabel("Axes (lignes d'esquisse)")).toBeVisible();
  await panel.getByLabel("Inverser le sens").selectOption("yes");
  await expect(status).toContainText("Prêt");
  const volume = async () => Number((await status.textContent())!.match(/Volume ([\d,]+)/)![1]!.replace(",", "."));
  // Through clearance hole M6 (the view scale depends on the framing: only the direction of the changes is checked).
  await expect.poll(volume).toBeLessThan(240);
  const clearance = await volume();
  await panel.getByLabel("Type").selectOption("counterbore");
  await expect.poll(volume).toBeLessThan(clearance);
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(page.locator(".feature-tree .error")).toHaveCount(0);

  // The XY plane was deselected when the sketch opened: the hole asks for its plane again; Escape cancels.
  await showPlanes();
  await expect(xy).not.toHaveClass(/active/);
  await page.getByRole("button", { name: "Perçage", exact: true }).click();
  await expect(status).toContainText("Cliquez une face plane ou un plan");
  await page.keyboard.press("Escape");
  await expect(status).not.toContainText("Cliquez une face plane");
  await showPlanes();
  await xy.click();
  await expect(page.locator(".sketch-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});
