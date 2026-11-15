import { expect, test } from "@playwright/test";

test("gesture menu: right-click drag, wheel per workbench, settings", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });

  const box = (await page.locator(".viewport canvas").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Part: the wheel opens after a few pixels, the targeted command is highlighted.
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(cx + 3, cy - 3);
  await expect(page.locator(".gesture-menu")).toHaveCount(0);
  await page.mouse.move(cx + 2, cy - 40, { steps: 4 }); // up = Esquisse (Sketch)
  const menu = page.locator(".gesture-menu");
  await expect(menu.locator(".gesture-item")).toHaveCount(8);
  await expect(menu.locator(".gesture-caption")).toHaveText("Esquisse");
  await page.screenshot({ path: test.info().outputPath("gestures-part.png") });
  await page.mouse.up({ button: "right" });
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".context")).toHaveCount(0); // no context menu after a gesture
  // The command was issued: sketch open.
  await expect(page.locator(".sketch-overlay")).toBeVisible();
  await page.getByRole("button", { name: "✓ Terminer l'esquisse" }).first().click();
  await expect(page.locator(".sketch-overlay")).toHaveCount(0);

  // Settings: 4 directions, and one command changed in the part wheel.
  await page.getByRole("button", { name: "Paramètres", exact: true }).click();
  await page.getByRole("button", { name: "Gestes souris…" }).click();
  const dialog = page.locator(".gest-dialog");
  await expect(dialog.locator(".keys-scopes button.active")).toHaveText("Pièce");
  // Each command of the default wheels exists in its workbench (otherwise the slot would display empty).
  // Analysis, CAM and Quoting come from private extensions (CAD_EXTENSIONS), absent from this build: not checked here.
  const empty = dialog.locator(".gest-cell select").filter({ has: page.locator("option:checked", { hasText: "— vide —" }) });
  // Workspaces of the open core (those of the modules appear only when their module is in the build).
  for (const [ctx, n] of [["Pièce", 0], ["Esquisse", 0], ["Esquisse 3D", 0], ["Assemblage", 0]] as const) {
    await dialog.locator(".keys-scopes button", { hasText: new RegExp(`^${ctx}( •)?$`) }).click();
    await expect(empty, ctx).toHaveCount(n);
  }
  await dialog.locator(".keys-scopes button", { hasText: /^Pièce/ }).click();
  await dialog.locator(".keys-preset select").selectOption("4");
  await expect(dialog.locator(".gest-cell")).toHaveCount(4);
  await dialog.locator(".gest-cell").filter({ has: page.locator("small", { hasText: /^Gauche$/ }) }).locator("select").selectOption("view.back");
  await page.screenshot({ path: test.info().outputPath("gestures-dialog.png") });
  await dialog.getByRole("button", { name: "Fermer" }).click();

  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(cx - 40, cy + 5, { steps: 4 });
  await expect(menu.locator(".gesture-item")).toHaveCount(4);
  await expect(menu.locator(".gesture-caption")).toHaveText("Vue arrière");
  await page.mouse.up({ button: "right" });
  await expect(menu).toHaveCount(0);

  expect(errors).toEqual([]);
});
