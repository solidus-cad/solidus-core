import { expect, test } from "@playwright/test";

test("spline through three points, closed by a line, extruded", async ({ page }) => {
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
  const box = (await page.locator(".viewport").boundingBox())!;
  const o = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // Spline from the origin through (40, 30) to (80, 0): a click on the last point ends it.
  await page.getByRole("button", { name: "Spline", exact: true }).click();
  await page.mouse.click(o.x, o.y);
  await page.mouse.click(o.x + 40, o.y - 30);
  await page.mouse.click(o.x + 80, o.y);
  await page.mouse.click(o.x + 80, o.y);
  await expect(page.locator(".sk-curve")).toHaveCount(1);
  await expect(page.locator(".sk-control")).toHaveCount(1);

  // Line back to the origin: a closed region.
  await page.getByRole("button", { name: "Ligne", exact: true }).click();
  await page.mouse.click(o.x + 80, o.y);
  await page.mouse.click(o.x, o.y);
  await page.keyboard.press("Escape");
  await expect(page.locator(".sk-region")).toHaveCount(1);
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();

  // Quadratic spline through (0,0), (40,30), (80,0) in screen units (scale s mm per pixel): its middle pole is (40, 60),
  // the region is a parabolic segment of area 1600 s², whose centre of gravity is (40 s, 12 s). Hence, whatever the
  // scale: area = x², y = 0.3 x.
  const panel = page.locator(".property-panel");
  await page.getByRole("button", { name: "Extrusion", exact: true }).click();
  await panel.getByLabel("Longueur", { exact: false }).last().fill("10");
  await expect(status).toContainText("Volume");
  await expect(status).not.toContainText("Recalcul");
  const text = (await status.textContent())!;
  const num = (s: string) => Number(s.replace(",", "."));
  const volume = num(text.match(/Volume ([\d,]+) cm³/)![1]!);
  const [x, y] = text.match(/CdG \(([-\d,]+); ([-\d,]+);/)!.slice(1).map(num) as [number, number];
  const area = (volume * 1000) / 10;
  expect(area / (x * x)).toBeGreaterThan(0.97);
  expect(area / (x * x)).toBeLessThan(1.03);
  expect(y / x).toBeCloseTo(0.3, 1);
  await page.getByRole("button", { name: "✓ Valider" }).click();
  expect(errors).toEqual([]);
});
