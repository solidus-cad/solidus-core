// Spur gear with an involute profile (approximated by a polyline). Example plugin feature function.
const rad = (d) => (d * Math.PI) / 180;

/** Gear profile: outer contour (polygon) and bore. */
function gearProfile(m, z, pressureDeg, bore) {
  const rp = (m * z) / 2; // pitch radius
  const rb = rp * Math.cos(rad(pressureDeg)); // base radius
  const ra = rp + m; // tip (addendum) radius
  const rf = Math.max(rp - 1.25 * m, 0.5); // root (dedendum) radius
  const inv = (a) => Math.tan(a) - a;
  const tPitch = Math.PI / (2 * z) + inv(Math.acos(rb / rp)); // half angular tooth thickness at the base circle
  const flank = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const r = Math.max(rb, rf) + ((ra - Math.max(rb, rf)) * i) / steps;
    flank.push([r, tPitch - inv(Math.acos(Math.min(1, rb / r)))]);
  }
  const pts = [];
  for (let k = 0; k < z; k++) {
    const c = (2 * Math.PI * k) / z;
    const at = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
    pts.push(at(rf, c - Math.PI / z));
    for (const [r, a] of flank) pts.push(at(r, c - a));
    for (const [r, a] of [...flank].reverse()) pts.push(at(r, c + a));
  }
  return { outer: { kind: "polygon", points: pts }, holes: bore > 0 ? [{ kind: "circle", center: [0, 0], r: bore / 2 }] : [] };
}

export default {
  async activate(ctx) {
    await ctx.features.define({
      type: "spurGear",
      label: { fr: "Roue dentée", en: "Spur gear" },
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
      params: [
        { key: "module", label: { fr: "Module", en: "Module" }, kind: "length", default: "2" },
        { key: "teeth", label: { fr: "Nombre de dents", en: "Teeth" }, kind: "number", default: "20" },
        { key: "thickness", label: { fr: "Épaisseur", en: "Thickness" }, kind: "length", default: "10" },
        { key: "bore", label: { fr: "Alésage", en: "Bore" }, kind: "length", default: "8" },
        { key: "pressure", label: { fr: "Angle de pression", en: "Pressure angle" }, kind: "enum", default: "20", options: [
          { value: "20", label: { fr: "20°", en: "20°" } },
          { value: "14.5", label: { fr: "14,5°", en: "14.5°" } },
        ] },
      ],
      build(v) {
        const z = Math.round(v.teeth);
        if (z < 6 || z > 300) throw new Error("nombre de dents entre 6 et 300");
        if (!(v.module > 0 && v.thickness > 0)) throw new Error("module et épaisseur positifs");
        return { mode: "add", solid: { op: "extrude", h: v.thickness, profile: gearProfile(v.module, z, Number(v.pressure), v.bore) } };
      },
    });
    await ctx.commands.register({
      id: "gear",
      label: { fr: "Roue dentée", en: "Spur gear" },
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>',
      run: () => ctx.document.beginFeature("spurGear"),
    });
    await ctx.tabs.register({ id: "main", label: { fr: "Exemple de plugin", en: "Plugin example" }, groups: [{ label: { fr: "Engrenage", en: "Gear" }, commands: ["gear"] }] });
  },
};
