import { expect, test } from "@playwright/test";

test("assembly: 3D sketch in a skeleton, drawing aids and constraint reference", async ({ page }) => {
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

  // 3D sketch: without a skeleton in the assembly, one is created.
  await page.getByRole("button", { name: "Esquisse 3D", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Esquisse 3D" })).toBeVisible();
  await expect(page.locator(".s3-hud")).toContainText("Plan de travail");

  // First point by keyboard, at the origin.
  await page.keyboard.type("0;0;0");
  await expect(page.locator(".s3-hud-typed")).toContainText("0;0;0");
  await page.keyboard.press("Enter");
  await expect(page.locator(".s3-overlay .sk-point")).toHaveCount(1);

  // Segment with the mouse: in isometric view, the Z axis is vertical on screen → Z inference.
  const o = await page.evaluate(() => document.querySelector(".s3-overlay .sk-point")!.getBoundingClientRect().toJSON() as DOMRect);
  const ox = o.x + o.width / 2;
  const oy = o.y + o.height / 2;
  await page.mouse.move(ox + 3, oy - 60);
  await page.mouse.move(ox + 4, oy - 90);
  await expect(page.locator(".s3-axis-guide")).toHaveCount(1);
  await expect(page.locator(".s3-tip")).toContainText("Z");
  await page.mouse.click(ox + 4, oy - 90);
  await expect(page.locator(".s3-line")).toHaveCount(1);
  await expect(page.locator(".sk-badge", { hasText: "Z" })).toHaveCount(1);

  // Direction locked by keyboard and length entered: driving dimension.
  await page.keyboard.press("x");
  await expect(page.locator(".s3-hud-lock")).toContainText("X");
  await page.keyboard.type("120");
  await page.keyboard.press("Enter");
  await page.keyboard.press("y");
  await page.keyboard.type("=40+20");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape"); // end of the polyline
  await expect(page.locator(".s3-line")).toHaveCount(3);
  await expect(page.locator(".sk-badge", { hasText: "X" })).toHaveCount(1);
  await expect(page.locator(".sk-badge", { hasText: "Y" })).toHaveCount(1);
  await expect(page.locator(".s3-dim-row")).toHaveCount(2);
  await expect(page.locator(".s3-overlay .sk-dim-label", { hasText: "120" })).toBeVisible();
  await expect(page.locator(".s3-overlay .sk-dim-label", { hasText: "40+20 = 60" })).toBeVisible();

  // Dimension changed from the panel.
  await page.locator(".s3-dim-row input").first().fill("150");
  await page.locator(".s3-dim-row input").first().press("Enter");
  await expect(page.locator(".s3-overlay .sk-dim-label", { hasText: "150" })).toBeVisible();

  // Undo / redo in the session (outside the input field).
  await page.locator(".s3-dim-row input").first().blur();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".s3-overlay .sk-dim-label", { hasText: "120" })).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(page.locator(".s3-overlay .sk-dim-label", { hasText: "150" })).toBeVisible();

  await page.getByRole("button", { name: "✓ Terminer" }).click();
  await expect(page.getByRole("tab", { name: "Esquisse 3D" })).toHaveCount(0);
  const row = page.locator(".tree-row", { hasText: "Esquisse 3D1" });
  await expect(row).toBeVisible();
  await expect(page.locator(".tree-row", { hasText: "Squelette1" })).toContainText("⌗");

  // 3D lines serve as references for the assembly constraints.
  await page.getByRole("button", { name: "Parallèle" }).click();
  const select = page.getByLabel("…ou un élément du squelette");
  await expect(select.locator("option", { hasText: "Esquisse 3D1 — ligne" })).toHaveCount(3);
  await select.selectOption({ label: "Esquisse 3D1 — ligne 2" });
  // First element selected: the constraint waits for an element of another component.
  await expect(page.getByText("Désignez un élément compatible d'un autre composant.")).toBeVisible();
  await page.keyboard.press("Escape");

  // Reopening: the geometry and dimensions are kept.
  await row.dblclick();
  await expect(page.locator(".s3-line")).toHaveCount(3);
  await expect(page.locator(".s3-dim-row input").first()).toHaveValue("150");
  await page.getByRole("button", { name: "✕ Annuler" }).click();
  expect(errors).toEqual([]);
});
