import { expect, test } from "@playwright/test";

test("projection of a model edge into a sketch", async ({ page }) => {
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
  // Front edge of the box (y = 0): on the horizontal axis, just right of the origin.
  const o = await page.evaluate(() => document.querySelector(".sk-point.origin")!.getBoundingClientRect().toJSON() as DOMRect);
  await page.keyboard.press("p");
  await page.mouse.click(o.x + o.width / 2 + 40, o.y + o.height / 2);
  await expect(page.locator(".sk-curve.projected")).toHaveCount(1);
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await expect(status).toContainText("Prêt");
  await expect(page.locator(".tree-row.error")).toHaveCount(0);
  expect(errors).toEqual([]);
});
