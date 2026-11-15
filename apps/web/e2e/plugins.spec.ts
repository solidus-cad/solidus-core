import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

const DIR = new URL("../../../examples/plugins/hello/", import.meta.url);
const hello = () =>
  Buffer.from(
    zipSync({
      "plugin.json": strToU8(readFileSync(new URL("plugin.json", DIR), "utf8")),
      "index.js": strToU8(readFileSync(new URL("index.js", DIR), "utf8")),
    }),
  );

test("plugins: development loading, tab, commands, form, removal", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    // Also runs in the isolated plugin iframe, which has no storage access.
    if (window !== window.top) return;
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });

  await page.locator(".menus").getByRole("button", { name: "Plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins" });
  await expect(dialog).toContainText("Aucun plugin actif.");
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Charger un plugin (développement)…" }).click();
  await (await chooser).setFiles({ name: "hello.vplug", mimeType: "application/zip", buffer: hello() });
  await expect(dialog).toContainText("Bonjour");
  await expect(dialog).toContainText("isolé");
  await expect(page.locator('iframe[data-plugin="com.exemple.hello"]')).toHaveCount(1);
  await dialog.getByRole("button", { name: "Fermer" }).click();

  // Plugin tab, after the built-in workbenches; its body replaces that of the Part workbench.
  const tab = page.locator(".ribbon-tabs").getByRole("tab", { name: "Bonjour" });
  await tab.click();
  await expect(tab).toHaveClass(/active/);
  await expect(page.locator(".ribbon-tabs").getByRole("tab", { name: "Pièce", exact: true })).not.toHaveClass(/active/);
  await page.locator(".ribbon-body").getByRole("button", { name: "Compter les fonctions" }).click();
  await expect(status).toContainText("fonction(s)");

  await page.locator(".ribbon-body").getByRole("button", { name: "Boîte paramétrée" }).click();
  const form = page.getByRole("dialog", { name: "Boîte" });
  await form.locator("input").fill("35");
  await form.getByRole("button", { name: "OK" }).click();
  await expect(status).toContainText("Côté choisi : 35 mm");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cad.plugin.com.exemple.hello") ?? "{}").lastSize)).toBe(35);

  // Back to the Part workbench, then removal of the plugin: tab and commands disappear.
  await page.locator(".ribbon-tabs").getByRole("tab", { name: "Pièce", exact: true }).click();
  await expect(page.getByRole("button", { name: "Boîte", exact: true })).toBeVisible();
  await tab.click();
  await page.locator(".menus").getByRole("button", { name: "Plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Retirer" }).click();
  await expect(dialog).toContainText("Aucun plugin actif.");
  await dialog.getByRole("button", { name: "Fermer" }).click();
  await expect(tab).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Boîte", exact: true })).toBeVisible();

  // Same plugin in the "trusted" host (verified publisher): same behavior, without an iframe.
  await page.locator(".menus").getByRole("button", { name: "Plugins", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /Exécuter isolé/ }).uncheck();
  const chooser2 = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Charger un plugin (développement)…" }).click();
  await (await chooser2).setFiles({ name: "hello.vplug", mimeType: "application/zip", buffer: hello() });
  await expect(dialog).toContainText("confiance");
  await expect(page.locator("iframe[data-plugin]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Fermer" }).click();
  await tab.click();
  await page.locator(".ribbon-body").getByRole("button", { name: "Compter les fonctions" }).click();
  await expect(status).toContainText("fonction(s)");
  expect(errors).toEqual([]);
});

const pkg = (manifest: object, code: string) => Buffer.from(zipSync({ "plugin.json": strToU8(JSON.stringify(manifest)), "index.js": strToU8(code) }));
const base = { name: { fr: "Hostile", en: "Hostile" }, version: "1.0.0", sdkVersion: 1, entry: "index.js", permissions: ["document.read"] };

async function loadPlugin(page: import("@playwright/test").Page, file: Buffer) {
  await page.locator(".menus").getByRole("button", { name: "Plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins" });
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Charger un plugin (développement)…" }).click();
  await (await chooser).setFiles({ name: "p.vplug", mimeType: "application/zip", buffer: file });
  return dialog;
}

test("plugins: the sandbox blocks network, storage and undeclared permissions; a blocked plugin is stopped", async ({ page }) => {
  await page.addInitScript(() => {
    // Also runs in the isolated plugin iframe, which has no storage access.
    if (window !== window.top) return;
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });

  const probe = `
    const tryIt = async (f) => { try { await f(); return "ouvert"; } catch { return "bloqué"; } };
    export default { async activate(ctx) {
      const r = {
        fetch: typeof fetch === "function" ? "ouvert" : "bloqué",
        xhr: typeof XMLHttpRequest === "function" ? "ouvert" : "bloqué",
        idb: typeof indexedDB === "object" && indexedDB ? "ouvert" : "bloqué",
        importDistant: await tryIt(() => import("https://example.com/x.js")),
        ctxFetch: await tryIt(() => ctx.fetch("https://example.com/")),
        ecriture: await tryIt(() => ctx.document.addFeature({ type: "box", name: "x", params: {} })),
        lecture: await tryIt(() => ctx.document.part()),
      };
      await ctx.ui.notify("SONDE " + JSON.stringify(r));
    } };`;
  const dialog = await loadPlugin(page, pkg({ ...base, id: "com.test.probe" }, probe));
  await expect(dialog).toContainText("Hostile");
  await expect(status).toContainText("SONDE");
  const report = JSON.parse((await status.textContent())!.split("SONDE ")[1]!.match(/\{.*\}/)![0]) as Record<string, string>;
  expect(report).toEqual({ fetch: "bloqué", xhr: "bloqué", idb: "bloqué", importDistant: "bloqué", ctxFetch: "bloqué", ecriture: "bloqué", lecture: "ouvert" });
  // The isolated iframe has no access to the application.
  await expect(page.locator('iframe[data-plugin="com.test.probe"]')).toHaveAttribute("sandbox", "allow-scripts");

  // Infinite loop on activation: the interface stays responsive, the plugin is stopped after the timeout.
  await dialog.getByRole("button", { name: "Retirer" }).click();
  await expect(page.locator("iframe[data-plugin]")).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Charger un plugin (développement)…" }).click();
  await (await chooser).setFiles({ name: "loop.vplug", mimeType: "application/zip", buffer: pkg({ ...base, id: "com.test.loop" }, "export default { activate() { for (;;) {} } };") });
  await dialog.getByRole("checkbox", { name: /Exécuter isolé/ }).uncheck(); // the interface responds during the loop
  await expect(dialog.locator(".field-error")).toContainText("délai dépassé", { timeout: 15_000 });
  await expect(page.locator("iframe[data-plugin]")).toHaveCount(0);
  await expect(dialog).toContainText("Aucun plugin actif.");
});

const gear = () => {
  const dir = new URL("../../../examples/plugins/gear/", import.meta.url);
  return Buffer.from(zipSync({ "plugin.json": strToU8(readFileSync(new URL("plugin.json", dir), "utf8")), "index.js": strToU8(readFileSync(new URL("index.js", dir), "utf8")) }));
};
const volume = async (page: import("@playwright/test").Page) => {
  const m = (await page.locator(".statusbar").textContent())!.match(/Volume ([\d\s ,]+) cm³/);
  return Number(m![1]!.replace(/[\s ]/g, "").replace(",", "."));
};

test("plugins: parametric feature in the sandbox, recomputation, shape frozen without the plugin", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });

  const dialog = await loadPlugin(page, gear());
  await expect(dialog).toContainText("Exemple de plugin (engrenage)");
  await dialog.getByRole("button", { name: "Fermer" }).click();

  await page.locator(".ribbon-tabs").getByRole("tab", { name: "Exemple de plugin" }).click();
  await page.locator(".ribbon-body").getByRole("button", { name: "Roue dentée" }).click();
  const panel = page.locator(".property-panel");
  await expect(panel.getByLabel("Nombre de dents")).toHaveValue("20");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await page.waitForTimeout(1500);
  await expect(status).toContainText("Volume");
  const v20 = await volume(page);
  // Gear m2 z20 b10, bore 8: between the root circle (r 17.5) and the tip circle (r 22), minus the bore.
  expect(v20).toBeGreaterThan((Math.PI * (17.5 ** 2 - 16) * 10) / 1000);
  expect(v20).toBeLessThan((Math.PI * (22 ** 2 - 16) * 10) / 1000);
  const row = page.locator(".tree-row", { hasText: "Roue dentée1" });
  await expect(row).not.toHaveClass(/error/);

  // Parameter changed: the plugin rebuilds the recipe.
  await row.dblclick();
  await panel.getByLabel("Nombre de dents").fill("30");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect.poll(() => volume(page)).toBeGreaterThan(v20 * 2);
  const v30 = await volume(page);

  // Value rejected by the plugin: error on the feature, the part stays displayed.
  await row.dblclick();
  await panel.getByLabel("Nombre de dents").fill("3");
  // While editing, the panel replaces the tree: the error is shown there and in the status bar.
  await expect(panel.locator(".panel-error")).toContainText("nombre de dents entre 6 et 300");
  await expect(status).toContainText("1 fonction(s) en erreur");
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveClass(/error/);

  // Plugin removed: the saved shape remains, the feature can no longer be edited.
  await page.locator(".menus").getByRole("button", { name: "Plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Retirer" }).click();
  await dialog.getByRole("button", { name: "Fermer" }).click();
  await page.getByRole("button", { name: "Boîte", exact: true }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect.poll(() => volume(page)).toBeGreaterThan(v30);
  await expect(row).not.toHaveClass(/error/);
  await row.dblclick();
  await expect(status).toContainText("absent : fonction figée");
  expect(errors).toEqual([]);
});
