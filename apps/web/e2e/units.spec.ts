import { expect, test, type Page } from "@playwright/test";

async function start(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("units-test")) return;
    sessionStorage.setItem("units-test", "1");
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
}

test("inches: sketch, extrusion and measurements in inches, stored with the suffix, shown in mm after the toggle", async ({ page }) => {
  const errors: string[] = [];
  await start(page, errors);
  const status = page.locator(".statusbar");
  const badge = status.locator("button.units");

  await expect(badge).toHaveText("mm");
  await badge.click();
  await expect(badge).toHaveText("in");

  // 4 × 2 in rectangle, extruded 1 in.
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
  for (const [i, v] of [[0, "4"], [1, "2"]] as const) {
    await clickCurve(i);
    await page.getByRole("button", { name: "Cote intelligente", exact: true }).click();
    await input.fill(v);
    await input.press("Enter");
  }
  await expect(page.locator(".sketch-overlay .sk-dim-label text")).toHaveText(["4", "2"]);
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await page.getByRole("button", { name: "Extrusion", exact: true }).click();
  const depth = page.locator(".property-panel").getByLabel("Longueur", { exact: false }).last();
  await depth.fill("1");
  await expect(page.locator(".property-panel .unit").first()).toHaveText("in");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 8 in³");
  await expect(status).toContainText("Surface 28 in²");

  // Dimensions shown in the view, then in mm after the toggle (stored values "4 in", "2 in", "1 in").
  await page.locator(".tree-row", { hasText: "Extrusion1" }).click({ button: "right" });
  await page.getByRole("button", { name: "Afficher les cotes" }).click();
  await expect(page.locator(".feature-dims .sk-dim-label text")).toHaveText(["4", "2", "1"]);
  await badge.click();
  await expect(badge).toHaveText("mm");
  await expect(page.locator(".feature-dims .sk-dim-label text")).toHaveText(["101.6", "50.8", "25.4"]);
  await expect(status).toContainText("Volume 131,1 cm³");

  // Typed in mm: stored as a bare number, shown in inches after the toggle.
  await page.locator(".feature-dims .sk-dim-label text", { hasText: /^25\.4$/ }).click();
  await input.fill("12.7");
  await input.press("Enter");
  await expect(status).toContainText("Volume 65,55 cm³");
  await badge.click();
  await expect(page.locator(".feature-dims .sk-dim-label text")).toHaveText(["4", "2", "0.5"]);

  // Preference kept after a reload.
  await page.reload();
  await expect(page.locator(".statusbar button.units")).toHaveText("in", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
