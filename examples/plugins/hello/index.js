// Example plugin. A real plugin would import `definePlugin` from @solidus-cad/sdk and be bundled into a single ES file.
const icon = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${body}</svg>`;

export default {
  async activate(ctx) {
    await ctx.commands.register({
      id: "count",
      label: { fr: "Compter les fonctions", en: "Count features" },
      icon: icon('<path d="M5 6h14M5 12h14M5 18h9"/>'),
      async run() {
        const part = await ctx.document.part();
        await ctx.ui.notify(part ? `${part.name} : ${part.features.length} fonction(s)` : "Pas de pièce active");
      },
    });
    await ctx.commands.register({
      id: "box",
      label: { fr: "Boîte paramétrée", en: "Parametric box" },
      icon: icon('<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>'),
      async run() {
        const v = await ctx.ui.form("Boîte", [
          { key: "size", label: { fr: "Côté (mm)", en: "Side (mm)" }, kind: "length", default: 20, min: 1 },
        ]);
        if (v) await ctx.storage.set("lastSize", v.size);
        if (v) await ctx.ui.notify(`Côté choisi : ${v.size} mm`);
      },
    });
    await ctx.tabs.register({
      id: "main",
      label: { fr: "Bonjour", en: "Hello" },
      docKinds: ["part"],
      groups: [{ label: { fr: "Exemple", en: "Example" }, commands: ["count", "box"] }],
    });
  },
};
