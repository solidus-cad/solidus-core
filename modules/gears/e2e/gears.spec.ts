import { expect, test, type Page } from "@playwright/test";

/** Volume shown in the status bar (cm³). */
const volume = async (page: Page) => {
  const m = (await page.locator(".statusbar").textContent())!.match(/Volume ([\d\s ,]+) cm³/);
  return Number(m![1]!.replace(/[\s ]/g, "").replace(",", "."));
};

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  await page.locator(".ribbon-tabs").getByRole("tab", { name: "Engrenages" }).click();
  return errors;
}

const create = async (page: Page, name: string) => {
  await page.locator(".ribbon-body").getByRole("button", { name }).click();
  await expect(page.locator(".property-panel")).toBeVisible();
};
const validate = async (page: Page) => {
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await page.waitForTimeout(1500);
};

test("gears: spur gear detailed, then simplified", async ({ page }) => {
  const errors = await open(page);
  await create(page, "Roue cylindrique");
  const panel = page.locator(".property-panel");
  await expect(panel.getByLabel("Nombre de dents")).toHaveValue("20");
  await validate(page);
  const detailed = await volume(page);
  // m2 z20 b10 bore 8: between the root circle (r 17.5) and the tip circle (r 22).
  expect(detailed).toBeGreaterThan((Math.PI * (17.5 ** 2 - 16) * 10) / 1000);
  expect(detailed).toBeLessThan((Math.PI * (22 ** 2 - 16) * 10) / 1000);

  const row = page.locator(".tree-row", { hasText: "Roue cylindrique1" });
  await row.dblclick();
  await panel.getByLabel("Représentation").selectOption("simplified");
  await validate(page);
  expect(await volume(page)).toBeCloseTo((Math.PI * (20 ** 2 - 16) * 10) / 1000, 2);

  // Value rejected by the module: the error is shown in the panel.
  await row.dblclick();
  await panel.getByLabel("Nombre de dents").fill("3");
  await expect(panel).toContainText("nombre de dents entre 6 et 300");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("gears: rack and simplified bevel gear", async ({ page }) => {
  await open(page);
  await create(page, "Crémaillère");
  await validate(page);
  // 12 teeth of module 2: 8 mm base below the root + teeth.
  const length = 12 * Math.PI * 2;
  expect(await volume(page)).toBeGreaterThan((length * 8 * 10) / 1000);

  await create(page, "Roue conique");
  await validate(page);
  await expect(page.locator(".tree-row", { hasText: "Roue conique1" })).not.toHaveClass(/error/);
});

test("gears: helical gear (twisted extrusion)", async ({ page }) => {
  const errors = await open(page);
  await create(page, "Roue cylindrique");
  const panel = page.locator(".property-panel");
  await panel.getByLabel("Angle d'hélice (0 = droite)").fill("20");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  // Smoothing the ~30 sections of the toothing takes longer than a straight extrusion.
  await expect(page.locator(".statusbar")).toContainText("Volume", { timeout: 90_000 });
  await expect(page.locator(".tree-row", { hasText: "Roue cylindrique1" })).not.toHaveClass(/error/);
  // Apparent module 2 / cos 20°: the volume stays between the apparent root and tip discs.
  const mt = 2 / Math.cos((20 * Math.PI) / 180);
  const v = await volume(page);
  expect(v).toBeGreaterThan((Math.PI * ((10 * mt - 1.25 * mt) ** 2 - 16) * 10) / 1000);
  expect(v).toBeLessThan((Math.PI * ((10 * mt + mt) ** 2 - 16) * 10) / 1000);
  expect(errors).toEqual([]);
});
