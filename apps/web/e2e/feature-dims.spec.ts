import { expect, test, type Page } from "@playwright/test";

async function start(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
}

/** Changes the displayed dimension whose label contains `text`. */
async function changeDim(page: Page, text: string, value: string) {
  await page.locator(".feature-dims .sk-dim-label text", { hasText: new RegExp(`^${text}$`) }).click();
  const input = page.locator(".sk-dim-input");
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press("Enter");
}

test("dimensions of an extrusion and its sketch changed without entering the feature", async ({ page }) => {
  const errors: string[] = [];
  await start(page, errors);
  const status = page.locator(".statusbar");

  // 100 × 50 rectangle dimensioned, from the origin.
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  const box = (await page.locator(".viewport").boundingBox())!;
  const o = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.keyboard.press("r");
  await page.mouse.click(o.x, o.y);
  await page.mouse.move(o.x + 60, o.y - 40);
  await page.mouse.click(o.x + 120, o.y - 80);
  const clickCurve = async (i: number) => {
    const b = await page.evaluate((n) => document.querySelectorAll(".sk-curve")[n]!.getBoundingClientRect().toJSON() as DOMRect, i);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  await page.keyboard.press("s");
  const input = page.locator(".sk-dim-input");
  for (const [i, v] of [[0, "100"], [1, "50"]] as const) {
    await clickCurve(i);
    await page.getByRole("button", { name: "Cote intelligente", exact: true }).click();
    await input.fill(v);
    await input.press("Enter");
  }
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await page.getByRole("button", { name: "Extrusion", exact: true }).click();
  await page.locator(".property-panel").getByLabel("Longueur", { exact: false }).last().fill("20");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 100 cm³");

  // Right-click in the tree: dimensions of the extrusion and its sketch.
  await page.locator(".tree-row", { hasText: "Extrusion1" }).click({ button: "right" });
  await page.getByRole("button", { name: "Afficher les cotes" }).click();
  await expect(page.locator(".dims-chip")).toContainText("Extrusion1");
  await expect(page.locator(".feature-dims .sk-dim-label")).toHaveCount(3);
  await expect(page.locator(".feature-dims .sk-dim-label text")).toHaveText(["100", "50", "20"]);

  await changeDim(page, "20", "40");
  await expect(status).toContainText("Volume 200 cm³");
  await changeDim(page, "100", "60");
  await expect(status).toContainText("Volume 120 cm³");
  await page.screenshot({ path: process.env.SHOT ?? "test-results/feature-dims.png" });

  // Undoable like any change; Escape hides the dimensions.
  await page.keyboard.press("Control+z");
  await expect(status).toContainText("Volume 200 cm³");
  await page.keyboard.press("Escape");
  await expect(page.locator(".dims-chip")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("dimensions of a box from the tree", async ({ page }) => {
  const errors: string[] = [];
  await start(page, errors);
  const status = page.locator(".statusbar");
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");

  await page.locator(".tree-row", { hasText: "Boîte1" }).click({ button: "right" });
  await page.getByRole("button", { name: "Afficher les cotes" }).click();
  await changeDim(page, "40", "20");
  await expect(status).toContainText("Volume 120 cm³");

  expect(errors).toEqual([]);
});

test("right-click on a face: dimensions of the feature that created it", async ({ page }) => {
  const errors: string[] = [];
  await start(page, errors);
  const status = page.locator(".statusbar");
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  // Cylinder removed in a corner: it becomes the selected feature in the tree.
  await page.getByRole("button", { name: "Cylindre" }).click();
  await page.locator(".property-panel").getByLabel("Opération").selectOption("cut");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).not.toContainText("Volume 240 cm³");
  await page.locator(".tree-row", { hasText: "Cylindre1" }).click();

  // Center of the view: a face of the box.
  const box = (await page.locator(".viewport").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.getByRole("button", { name: "Afficher les cotes : Boîte1" }).click();
  await expect(page.locator(".dims-chip")).toContainText("Boîte1");

  expect(errors).toEqual([]);
});
