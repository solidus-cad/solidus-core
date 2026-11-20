import { expect, test, type Page } from "@playwright/test";

/** Center of the view (initial sketch origin: 1 px = 1 mm, Y up). */
async function origin(page: Page) {
  const box = (await page.locator(".viewport").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function rectangleSketch(page: Page, dx: number) {
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  const o = await origin(page);
  await page.keyboard.press("r");
  await page.mouse.click(o.x + dx, o.y);
  await page.mouse.click(o.x + dx + 60, o.y - 40);
  await expect(page.locator(".sk-region")).toHaveCount(1);
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await expect(page.locator(".sketch-overlay")).toHaveCount(0);
}

test("sketches folded under their features, shared by pick then click", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });

  await rectangleSketch(page, 0);
  await rectangleSketch(page, 100);
  const tree = page.locator(".tree-list");
  const row = (name: string) => tree.locator(".tree-row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

  // Extrusion 1 on Esquisse2 (last sketch), Extrusion 2 on Esquisse1 (selected sketch).
  await page.getByRole("button", { name: "Extrusion", exact: true }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Prêt");
  await row("Esquisse1").click();
  await page.getByRole("button", { name: "Extrusion", exact: true }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Prêt");

  // Both sketches folded: only the two features at the top level.
  await expect(tree.locator(".tree-row:not(.nested) .name")).toHaveText(["Extrusion1", "Extrusion2"]);
  await row("Extrusion1").locator(".fold").click();
  await expect(tree.locator(".tree-row.nested .name")).toHaveText(["Esquisse2"]);

  // Esquisse2 picked in the fold, then Extrusion2 clicked: Extrusion2 now builds on it, Esquisse1 is free again.
  await row("Esquisse2").click();
  await expect(row("Extrusion2")).toHaveClass(/assignable/);
  await row("Extrusion2").click();
  await expect(status).toContainText("Prêt");
  await expect(tree.locator(".tree-row:not(.nested) .name")).toHaveText(["Esquisse1", "Extrusion1", "Extrusion2"]);
  await expect(tree.locator(".tree-row.nested .name")).toHaveText(["Esquisse2", "Esquisse2"]);
  await expect(tree.locator(".tree-row.assignable")).toHaveCount(0);
  await page.screenshot({ path: process.env.SHOT_FOLDS ?? "test-results/tree-folds.png" });

  // Undo: back to the previous assignment.
  await page.keyboard.press("Control+z");
  await expect(tree.locator(".tree-row:not(.nested) .name")).toHaveText(["Extrusion1", "Extrusion2"]);

  expect(errors).toEqual([]);
});
