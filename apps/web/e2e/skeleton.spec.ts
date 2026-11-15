import { expect, test } from "@playwright/test";

test("assembly: skeleton edited in context, constraint on a skeleton line", async ({ page }) => {
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

  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  await page.getByRole("button", { name: "Insérer" }).click();
  await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  await page.getByRole("button", { name: "Insérer" }).click();
  await page.getByRole("button", { name: "+ Nouveau squelette" }).click();
  const skel = page.locator(".tree-row", { hasText: "Squelette1" });
  await expect(skel).toContainText("⌗");

  // In-context edit of the skeleton: a sketch line.
  await skel.dblclick();
  await page.getByRole("button", { name: "Esquisse", exact: true }).click();
  await expect(page.locator('.sketch-overlay[data-settled="yes"]')).toBeVisible();
  const o = await page.evaluate(() => document.querySelector(".sk-point.origin")!.getBoundingClientRect().toJSON() as DOMRect);
  const ox = o.x + o.width / 2;
  const oy = o.y + o.height / 2;
  await page.keyboard.press("l");
  await page.mouse.click(ox + 60, oy - 80);
  await page.mouse.click(ox + 160, oy - 80);
  await page.keyboard.press("Escape");
  await expect(page.locator(".sk-curve")).toHaveCount(1);
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await page.getByRole("button", { name: "↩ Retour à l'assemblage" }).click();
  await expect(status).toContainText("2 occurrence(s)"); // the part and the skeleton

  // "Parallel" constraint: skeleton line, then a box face.
  await page.getByRole("button", { name: "Parallèle" }).click();
  const select = page.getByLabel("…ou un élément du squelette");
  await expect(select.locator("option", { hasText: "ligne 1" })).toHaveCount(1);
  await select.selectOption({ label: "Esquisse1 — ligne 1" });
  await expect(page.getByText("Désignez un élément compatible d'un autre composant.")).toBeVisible();
  expect(errors).toEqual([]);
});
