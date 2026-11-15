import { expect, test, type Page } from "@playwright/test";

/** Center of the view (initial sketch origin: 1 px = 1 mm, Y up). */
async function origin(page: Page) {
  const box = (await page.locator(".viewport").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("dimensioned sketch, then extruded", async ({ page }) => {
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

  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator(".sketch-overlay")).toBeVisible();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible(); // camera oriented
  await expect(page.getByRole("button", { name: "Ligne", exact: true })).toHaveAttribute("aria-pressed", "true"); // default tool
  const o = await origin(page);

  // Rectangle from the origin (snap) to (120, 80)
  await page.keyboard.press("r");
  await page.mouse.click(o.x, o.y);
  await page.mouse.move(o.x + 60, o.y - 40);
  await page.mouse.click(o.x + 120, o.y - 80);
  const panel = page.locator(".property-panel");
  await expect(panel).toContainText("2 degré(s) de liberté");
  await expect(panel).toContainText("1 contour(s) fermé(s)");
  await expect(page.locator(".sk-region")).toHaveCount(1); // closed region tinted

  // Rectangle lines in creation order: bottom, right, top, left.
  const clickCurve = async (i: number) => {
    // getBoundingClientRect: a horizontal line has zero height (boundingBox would consider it invisible).
    // Atomic read: elements may be recreated between two Playwright calls.
    const b = await page.evaluate((n) => document.querySelectorAll(".sk-curve")[n]!.getBoundingClientRect().toJSON() as DOMRect, i);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };

  // Dimension of the bottom line: 100
  await page.keyboard.press("s");
  await clickCurve(0);
  await expect(page.locator(".sk-curve.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Cote intelligente", exact: true }).click();
  const input = page.locator(".sk-dim-input");
  await expect(input).toBeVisible();
  await input.fill("100");
  await input.press("Enter");
  // Dimension of the right side: 50
  await clickCurve(1);
  await expect(page.locator(".sk-curve.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Cote intelligente", exact: true }).click();
  await input.fill("50");
  await input.press("Enter");
  await expect(panel).toContainText("Totalement contrainte");
  await expect(page.locator(".sk-dim-label", { hasText: "50" })).toBeVisible();
  await page.screenshot({ path: process.env.SHOT_SKETCH ?? "test-results/sketch.png" });

  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await expect(page.locator(".sketch-overlay")).toHaveCount(0);

  // Reopened sketch: select tool by default
  await page.locator(".tree-row", { hasText: "Esquisse" }).first().dblclick();
  await expect(page.locator(".sketch-overlay")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sélection", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await expect(page.locator(".sketch-overlay")).toHaveCount(0);

  // Extrusion by 20
  await page.getByRole("button", { name: "Extrusion", exact: true }).click();
  await panel.getByLabel("Longueur", { exact: false }).last().fill("20");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 100 cm³");
  await expect(status).toContainText("Prêt");
  await page.getByRole("button", { name: "Affichage" }).click();
  await page.getByRole("button", { name: "Vue isométrique" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT_EXTRUDE ?? "test-results/extrude.png" });

  expect(errors).toEqual([]);
});

test("thin extrusion of an open polyline", async ({ page }) => {
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

  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  const o = await origin(page);
  // Open L: 100 to the right, then 60 up.
  await page.keyboard.press("l");
  await page.mouse.click(o.x + 20, o.y - 20);
  await page.mouse.click(o.x + 120, o.y - 20);
  await page.mouse.click(o.x + 120, o.y - 80);
  await page.keyboard.press("Escape");
  await expect(page.locator(".sk-curve")).toHaveCount(2);
  await expect(page.locator(".sk-region")).toHaveCount(0); // open profile: nothing to tint
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();

  await page.getByRole("button", { name: "Extrusion mince", exact: true }).click();
  const panel = page.locator(".property-panel");
  await expect(status).toContainText("Volume");
  // Volume proportional to the thickness (centered: profile length × thickness × depth).
  const volume = async () => Number((await status.textContent())!.match(/Volume ([\d,]+)/)![1]!.replace(",", "."));
  await panel.getByLabel("Côté de l'épaisseur").selectOption("both");
  await expect(status).toContainText("Prêt");
  const v2 = await volume();
  await panel.getByRole("textbox", { name: "Épaisseur mm" }).fill("6");
  await expect.poll(volume).toBeCloseTo(v2 * 3, 0);
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(page.locator(".feature-tree .error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("sketch axes: snapping to the path and coincidence", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  const o = await origin(page);
  const panel = page.locator(".property-panel");
  // Screen positions (overlay frame): origin first, then the sketch points.
  const points = () =>
    page.evaluate(() => [...document.querySelectorAll(".sk-point")].map((c) => ({ x: Number(c.getAttribute("cx")), y: Number(c.getAttribute("cy")) })));

  // Start 3 px from the vertical axis: the point snaps to it and stays constrained there (4 − 1 degrees of freedom).
  await page.keyboard.press("l");
  await page.mouse.move(o.x + 3, o.y - 100);
  await expect(page.locator(".sk-axis.v.hover")).toHaveCount(1);
  await page.mouse.click(o.x + 3, o.y - 100);
  await page.mouse.click(o.x + 100, o.y - 150);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(panel).toContainText("3 degré(s) de liberté");
  const [o0, p1] = await points();
  expect(p1!.x).toBeCloseTo(o0!.x, 3);

  // Any point + horizontal axis (selected), then Coincidence: the point moves onto the axis.
  await page.keyboard.press("s");
  await page.mouse.click(o.x + 100, o.y - 150);
  await page.keyboard.down("Shift");
  await page.mouse.click(o.x - 200, o.y + 2);
  await page.keyboard.up("Shift");
  await expect(page.locator(".sk-axis.h.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Coïncidence", exact: true }).click();
  await expect(panel).toContainText("2 degré(s) de liberté");
  expect((await points())[2]!.y).toBeCloseTo(o0!.y, 3);
});
