import { SECTION_FAMILIES, THREAD_SIZE_KEY, THREADS, type Bench, type FeatureDefinition, type ParamSpec } from "@solidus-cad/sdk";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

const ICONS = {
  sketch: svg('<path d="M4 18h16M4 18V6"/><rect x="7" y="8" width="8" height="6" stroke-dasharray="2 1.5"/><path d="m14 4 6 6-8 8H6v-6z" fill="none"/>'),
  extrude: svg('<path d="M5 15h10l4-3H9z"/><path d="M5 15V8l4-3h10v7M5 8h10l4-3M15 8v7"/><path d="M12 2v3" />'),
  twistExtrude: svg('<path d="M5 19h10l4-3H9z"/><path d="M7 16C7 11 15 12 15 7M11 16C11 11 19 12 19 7"/><path d="M9 4h10l-2 3H7z"/>'),
  thinExtrude: svg('<path d="M4 16h4V9h7l4-3h-7l-4 3"/><path d="M4 16l4-3V6M8 9V6M8 6h7" /><path d="M6 17.5h3.5V10.5" stroke-dasharray="1.5 1.5"/>'),
  revolve: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M8 7h-2a2 3 0 0 0 0 10h2"/><path d="M16 7h2a2 3 0 0 1 0 10h-2"/><path d="m18 14 0 3-3 0"/>'),
  loft: svg('<path d="M4 19h8l3-2H7z"/><path d="M6 11h10l2-2H8z"/><path d="M9 4h6l1-1h-6z"/><path d="M4 19 6 11 9 4M15 17l3-8-2-6" stroke-dasharray="2 1.5"/>'),
  sweep: svg('<path d="M4 18c4 0 5-12 10-12h6" /><ellipse cx="4" cy="18" rx="1.5" ry="3"/><ellipse cx="20" cy="6" rx="1.5" ry="3"/>'),
  hole: svg('<path d="M3 9l9-4 9 4-9 4z"/><ellipse cx="12" cy="9" rx="3" ry="1.3"/><path d="M9 9v8a3 1.3 0 0 0 6 0V9" stroke-dasharray="2 1.5"/>'),
  slot: svg('<path d="M3 9l9-4 9 4-9 4z"/><rect x="7" y="7.6" width="10" height="2.8" rx="1.4"/><path d="M7 9v7M17 9v7" stroke-dasharray="2 1.5"/>'),
  mirror: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7 4 9v8l5-2zM15 7l5 2v8l-5-2z"/>'),
  linearPattern: svg('<rect x="3" y="9" width="5" height="5"/><rect x="10" y="9" width="5" height="5" stroke-dasharray="2 1.5"/><rect x="17" y="9" width="4" height="5" stroke-dasharray="2 1.5"/>'),
  circularPattern: svg('<circle cx="12" cy="12" r="7" stroke-dasharray="2 2"/><circle cx="12" cy="5" r="2"/><circle cx="18" cy="15" r="2"/><circle cx="6" cy="15" r="2"/>'),
  shell: svg('<path d="M4 8l8-4 8 4v9l-8 4-8-4z"/><path d="M7 9.5l5-2.5 5 2.5v6l-5 2.5-5-2.5z" stroke-dasharray="2 1.5"/>'),
  draft: svg('<path d="M3 20h18"/><path d="M5 20 8 5h8l3 15"/><path d="M8 20V5M16 20V5" stroke-dasharray="1.5 2"/>'),
  profile: svg('<path d="M5 6h8M5 18h8M9 6v12"/><path d="M13 6l6-3M13 18l6-3M19 3v12" stroke-dasharray="2 1.5"/>'),
  box: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
  cylinder: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>'),
  fillet: svg('<path d="M4 20V10a6 6 0 0 1 6-6h10"/><path d="M4 4h4M4 4v4" stroke-dasharray="1.5 2"/>'),
  chamfer: svg('<path d="M4 20V10l6-6h10"/><path d="M4 4h4M4 4v4" stroke-dasharray="1.5 2"/>'),
  combineBodies: svg('<rect x="3" y="7" width="11" height="11"/><rect x="10" y="4" width="11" height="11" stroke-dasharray="2 1.5"/>'),
  deleteBody: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M9 10l6 6M15 10l-6 6"/>'),
  moveBody: svg('<rect x="3" y="11" width="9" height="9" stroke-dasharray="2 1.5"/><rect x="12" y="4" width="9" height="9"/><path d="M8 11 12 7"/>'),
  splitBody: svg('<path d="M4 8l8-4 8 4v9l-8 4-8-4z"/><path d="M2 13h20" stroke-dasharray="2 1.5"/>'),
};

const position: ParamSpec[] = [
  { key: "x", label: { fr: "Position X", en: "Position X" }, kind: "length", default: "0" },
  { key: "y", label: { fr: "Position Y", en: "Position Y" }, kind: "length", default: "0" },
  { key: "z", label: { fr: "Position Z", en: "Position Z" }, kind: "length", default: "0" },
];

const operation: ParamSpec = {
  key: "op",
  label: { fr: "Opération", en: "Operation" },
  kind: "enum",
  default: "add",
  options: [
    { value: "add", label: { fr: "Ajout de matière", en: "Add material" } },
    { value: "cut", label: { fr: "Enlèvement de matière", en: "Remove material" } },
    { value: "intersect", label: { fr: "Intersection", en: "Intersect" } },
    { value: "new", label: { fr: "Nouveau corps", en: "New body" } },
  ],
};

const reverse: ParamSpec = {
  key: "reverse",
  label: { fr: "Inverser le sens", en: "Reverse direction" },
  kind: "enum",
  default: "no",
  options: [
    { value: "no", label: { fr: "Non", en: "No" } },
    { value: "yes", label: { fr: "Oui", en: "Yes" } },
  ],
};

const sketchFeatures: FeatureDefinition[] = [
  {
    type: "sketch",
    label: { fr: "Esquisse", en: "Sketch" },
    icon: ICONS.sketch,
    params: [],
  },
  {
    type: "extrude",
    label: { fr: "Extrusion", en: "Extrude" },
    icon: ICONS.extrude,
    params: [
      { key: "sketch", label: { fr: "Esquisse", en: "Sketch" }, kind: "sketch", default: "" },
      operation,
      {
        key: "mode",
        label: { fr: "Limite", en: "End condition" },
        kind: "enum",
        default: "blind",
        options: [
          { value: "blind", label: { fr: "Longueur", en: "Blind" } },
          { value: "symmetric", label: { fr: "Symétrique", en: "Mid-plane" } },
          { value: "throughAll", label: { fr: "À travers tout", en: "Through all" } },
        ],
      },
      { key: "depth", label: { fr: "Longueur", en: "Depth" }, kind: "length", default: "20" },
      reverse,
    ],
  },
  {
    type: "twistExtrude",
    label: { fr: "Extrusion torsadée", en: "Twisted extrude" },
    icon: ICONS.twistExtrude,
    params: [
      { key: "sketch", label: { fr: "Esquisse", en: "Sketch" }, kind: "sketch", default: "" },
      operation,
      {
        key: "mode",
        label: { fr: "Limite", en: "End condition" },
        kind: "enum",
        default: "blind",
        options: [
          { value: "blind", label: { fr: "Longueur", en: "Blind" } },
          { value: "symmetric", label: { fr: "Symétrique", en: "Mid-plane" } },
        ],
      },
      { key: "depth", label: { fr: "Longueur", en: "Depth" }, kind: "length", default: "20" },
      { key: "twist", label: { fr: "Torsion totale", en: "Total twist" }, kind: "angle", default: "30" },
      reverse,
    ],
  },
  {
    type: "thinExtrude",
    label: { fr: "Extrusion mince", en: "Thin extrude" },
    icon: ICONS.thinExtrude,
    params: [
      { key: "sketch", label: { fr: "Esquisse (profil ouvert)", en: "Sketch (open profile)" }, kind: "sketch", default: "" },
      operation,
      {
        key: "mode",
        label: { fr: "Limite", en: "End condition" },
        kind: "enum",
        default: "blind",
        options: [
          { value: "blind", label: { fr: "Longueur", en: "Blind" } },
          { value: "symmetric", label: { fr: "Symétrique", en: "Mid-plane" } },
          { value: "throughAll", label: { fr: "À travers tout", en: "Through all" } },
        ],
      },
      { key: "depth", label: { fr: "Longueur", en: "Depth" }, kind: "length", default: "20" },
      reverse,
      { key: "thickness", label: { fr: "Épaisseur", en: "Thickness" }, kind: "length", default: "2" },
      {
        key: "thinSide",
        label: { fr: "Côté de l'épaisseur", en: "Thickness side" },
        kind: "enum",
        default: "side1",
        options: [
          { value: "side1", label: { fr: "Un côté", en: "One side" } },
          { value: "side2", label: { fr: "Autre côté", en: "Other side" } },
          { value: "both", label: { fr: "Centrée", en: "Mid-plane" } },
        ],
      },
    ],
  },
  {
    type: "revolve",
    label: { fr: "Révolution", en: "Revolve" },
    icon: ICONS.revolve,
    params: [
      { key: "sketch", label: { fr: "Esquisse", en: "Sketch" }, kind: "sketch", default: "" },
      operation,
      { key: "axis", label: { fr: "Axe", en: "Axis" }, kind: "sketchAxis", default: "axis:V" },
      { key: "angle", label: { fr: "Angle", en: "Angle" }, kind: "angle", default: "360" },
    ],
  },
];

const yesNo = (key: string, fr: string, en: string): ParamSpec => ({ ...reverse, key, label: { fr, en } });

const axisOptions = (["X", "Y", "Z"] as const).map((a) => ({ value: a, label: { fr: a, en: a } }));

const holeSize: ParamSpec = {
  key: "size",
  label: { fr: "Taille", en: "Size" },
  kind: "enum",
  default: "M6",
  options: ["M3", "M4", "M5", "M6", "M8", "M10", "M12", "M16", "M20", "M24"].map((m) => ({ value: m, label: { fr: m, en: m } })),
};

const tapped = { key: "type", is: ["tapped"] };

/** Thread of a tapped hole: standard, then the size in that standard (or nominal diameter and pitch). */
const threadParams: ParamSpec[] = [
  {
    key: "thread",
    label: { fr: "Norme de filetage", en: "Thread standard" },
    kind: "enum",
    default: "M",
    when: tapped,
    options: [
      { value: "M", label: { fr: "Métrique ISO (M)", en: "ISO metric (M)" } },
      { value: "MF", label: { fr: "Métrique pas fin (M×P)", en: "ISO metric fine (M×P)" } },
      { value: "G", label: { fr: "Gaz cylindrique G (ISO 228)", en: "Pipe parallel G (ISO 228)" } },
      { value: "Rc", label: { fr: "Gaz conique Rc (ISO 7)", en: "Pipe taper Rc (ISO 7)" } },
      { value: "NPT", label: { fr: "NPT (gaz américain)", en: "NPT (American pipe)" } },
      { value: "UNC", label: { fr: "UNC (unifié gros pas)", en: "UNC (unified coarse)" } },
      { value: "UNF", label: { fr: "UNF (unifié pas fin)", en: "UNF (unified fine)" } },
      { value: "custom", label: { fr: "Personnalisé (Ø × pas)", en: "Custom (Ø × pitch)" } },
    ],
  },
  ...(["MF", "G", "Rc", "NPT", "UNC", "UNF"] as const).map((std): ParamSpec => {
    const sizes = Object.keys(THREADS[std]);
    return {
      key: THREAD_SIZE_KEY[std],
      label: { fr: "Taille", en: "Size" },
      kind: "enum",
      default: sizes[Math.min(2, sizes.length - 1)]!,
      when: { key: "thread", is: [std], and: tapped },
      options: sizes.map((n) => ({ value: n, label: { fr: n, en: n } })),
    };
  }),
  { key: "threadD", label: { fr: "Diamètre nominal", en: "Nominal diameter" }, kind: "length", default: "10", when: { key: "thread", is: ["custom"], and: tapped } },
  { key: "threadPitch", label: { fr: "Pas", en: "Pitch" }, kind: "length", default: "1.5", when: { key: "thread", is: ["custom"], and: tapped } },
];

const holeFeatures: FeatureDefinition[] = [
  {
    type: "sweep",
    label: { fr: "Balayage", en: "Sweep" },
    icon: ICONS.sweep,
    params: [
      { key: "path", label: { fr: "Chemin (esquisse 2D ou 3D)", en: "Path (2D or 3D sketch)" }, kind: "sketch", space: "any", default: "" },
      operation,
      {
        key: "profile",
        label: { fr: "Section", en: "Profile" },
        kind: "enum",
        default: "circle",
        options: [
          { value: "circle", label: { fr: "Circulaire", en: "Circular" } },
          { value: "sketch", label: { fr: "Esquisse", en: "Sketch" } },
        ],
      },
      { key: "diameter", label: { fr: "Diamètre", en: "Diameter" }, kind: "length", default: "10", when: { key: "profile", is: ["circle"] } },
      { key: "inner", label: { fr: "Diamètre intérieur (0 = plein)", en: "Inner diameter (0 = solid)" }, kind: "length", default: "0", when: { key: "profile", is: ["circle"] } },
      { key: "profileSketch", label: { fr: "Esquisse de section", en: "Profile sketch" }, kind: "sketch", default: "", when: { key: "profile", is: ["sketch"] } },
    ],
  },
  {
    // Same constructor as the surface loft of the Surfaces module (core/part/loft.cpp), with closed sections.
    type: "loft",
    label: { fr: "Lissage", en: "Loft" },
    icon: ICONS.loft,
    params: [
      { key: "sections", label: { fr: "Sections (dans l'ordre)", en: "Sections (in order)" }, kind: "sketches", default: "" },
      operation,
      { key: "guides", label: { fr: "Courbes guides (facultatives)", en: "Guide curves (optional)" }, kind: "sketches", space: "any", max: 2, default: "" },
      yesNo("ruled", "Réglé (faces planes entre sections)", "Ruled (flat faces between sections)"),
    ],
  },
  {
    type: "hole",
    label: { fr: "Perçage", en: "Hole" },
    icon: ICONS.hole,
    params: [
      { key: "sketch", label: { fr: "Positions (points d'esquisse)", en: "Positions (sketch points)" }, kind: "sketch", default: "" },
      {
        key: "type",
        label: { fr: "Type", en: "Type" },
        kind: "enum",
        default: "simple",
        options: [
          { value: "simple", label: { fr: "Passage", en: "Clearance" } },
          { value: "tapped", label: { fr: "Taraudé", en: "Tapped" } },
          { value: "counterbore", label: { fr: "Lamé (ISO 4762)", en: "Counterbore (ISO 4762)" } },
          { value: "countersink", label: { fr: "Fraisé 90° (ISO 10642)", en: "Countersink 90° (ISO 10642)" } },
        ],
      },
      // Metric coarse size: also the clearance / counterbore / countersink size.
      { ...holeSize, when: { key: "type", is: ["simple", "counterbore", "countersink"], or: { key: "thread", is: ["M"] } } },
      ...threadParams,
      {
        key: "mode",
        label: { fr: "Limite", en: "End condition" },
        kind: "enum",
        default: "throughAll",
        options: [
          { value: "throughAll", label: { fr: "Débouchant", en: "Through all" } },
          { value: "blind", label: { fr: "Borgne", en: "Blind" } },
        ],
      },
      { key: "depth", label: { fr: "Profondeur", en: "Depth" }, kind: "length", default: "10", when: { key: "mode", is: ["blind"] } },
      reverse,
    ],
  },
  {
    type: "slot",
    label: { fr: "Oblong", en: "Slot" },
    icon: ICONS.slot,
    params: [
      { key: "sketch", label: { fr: "Axes (lignes d'esquisse)", en: "Axes (sketch lines)" }, kind: "sketch", default: "" },
      {
        key: "widthMode",
        label: { fr: "Largeur", en: "Width" },
        kind: "enum",
        default: "clearance",
        options: [
          { value: "clearance", label: { fr: "Passage de vis (ISO 273)", en: "Screw clearance (ISO 273)" } },
          { value: "manual", label: { fr: "Valeur saisie", en: "Custom value" } },
        ],
      },
      { ...holeSize, when: { key: "widthMode", is: ["clearance"] } },
      {
        key: "type",
        label: { fr: "Type", en: "Type" },
        kind: "enum",
        default: "simple",
        options: [
          { value: "simple", label: { fr: "Passage", en: "Clearance" } },
          { value: "counterbore", label: { fr: "Lamé (ISO 4762)", en: "Counterbore (ISO 4762)" } },
          { value: "countersink", label: { fr: "Fraisé 90° (ISO 10642)", en: "Countersink 90° (ISO 10642)" } },
        ],
        when: { key: "widthMode", is: ["clearance"] },
      },
      { key: "width", label: { fr: "Largeur", en: "Width" }, kind: "length", default: "10", when: { key: "widthMode", is: ["manual"] } },
      {
        key: "mode",
        label: { fr: "Limite", en: "End condition" },
        kind: "enum",
        default: "throughAll",
        options: [
          { value: "throughAll", label: { fr: "Débouchant", en: "Through all" } },
          { value: "blind", label: { fr: "Borgne", en: "Blind" } },
        ],
      },
      { key: "depth", label: { fr: "Profondeur", en: "Depth" }, kind: "length", default: "10", when: { key: "mode", is: ["blind"] } },
      reverse,
    ],
  },
];

const profileFeature: FeatureDefinition = {
  type: "profile",
  label: { fr: "Profilé", en: "Structural profile" },
  icon: ICONS.profile,
  params: [
    { key: "path", label: { fr: "Chemin (esquisse)", en: "Path (sketch)" }, kind: "sketch", default: "" },
    {
      key: "family",
      label: { fr: "Famille", en: "Family" },
      kind: "enum",
      default: "IPE",
      options: SECTION_FAMILIES.map((f) => ({ value: f.id, label: f.label })),
    },
    ...SECTION_FAMILIES.map(
      (f): ParamSpec => ({
        key: `size_${f.id}`,
        label: { fr: "Taille", en: "Size" },
        kind: "enum",
        default: f.sizes[Math.floor(f.sizes.length / 3)]!,
        options: f.sizes.map((s) => ({ value: s, label: { fr: s, en: s } })),
        when: { key: "family", is: [f.id] },
      }),
    ),
    { key: "rotation", label: { fr: "Rotation de la section", en: "Section rotation" }, kind: "angle", default: "0" },
  ],
};

const patternFeatures: FeatureDefinition[] = [
  {
    type: "mirror",
    label: { fr: "Symétrie", en: "Mirror" },
    icon: ICONS.mirror,
    params: [
      { key: "feature", label: { fr: "Fonction à répéter", en: "Feature to mirror" }, kind: "feature", default: "", allowBody: true },
      { key: "plane", label: { fr: "Plan de symétrie", en: "Mirror plane" }, kind: "plane", default: "YZ" },
      { key: "offset", label: { fr: "Décalage du plan", en: "Plane offset" }, kind: "length", default: "0" },
    ],
  },
  {
    type: "linearPattern",
    label: { fr: "Matrice linéaire", en: "Linear pattern" },
    icon: ICONS.linearPattern,
    params: [
      { key: "feature", label: { fr: "Fonction à répéter", en: "Feature to pattern" }, kind: "feature", default: "" },
      { key: "direction", label: { fr: "Direction 1", en: "Direction 1" }, kind: "enum", default: "X", options: axisOptions },
      yesNo("reverse", "Inverser la direction 1", "Reverse direction 1"),
      { key: "count", label: { fr: "Nombre (direction 1)", en: "Count (direction 1)" }, kind: "number", default: "3" },
      { key: "spacing", label: { fr: "Pas (direction 1)", en: "Spacing (direction 1)" }, kind: "length", default: "20" },
      {
        key: "direction2",
        label: { fr: "Direction 2", en: "Direction 2" },
        kind: "enum",
        default: "none",
        options: [{ value: "none", label: { fr: "Aucune", en: "None" } }, ...axisOptions],
      },
      { key: "count2", label: { fr: "Nombre (direction 2)", en: "Count (direction 2)" }, kind: "number", default: "2", when: { key: "direction2", is: ["X", "Y", "Z"] } },
      { key: "spacing2", label: { fr: "Pas (direction 2)", en: "Spacing (direction 2)" }, kind: "length", default: "20", when: { key: "direction2", is: ["X", "Y", "Z"] } },
    ],
  },
  {
    type: "circularPattern",
    label: { fr: "Matrice circulaire", en: "Circular pattern" },
    icon: ICONS.circularPattern,
    params: [
      { key: "feature", label: { fr: "Fonction à répéter", en: "Feature to pattern" }, kind: "feature", default: "" },
      { key: "axis", label: { fr: "Axe (passant par l'origine)", en: "Axis (through origin)" }, kind: "enum", default: "Z", options: axisOptions },
      { key: "count", label: { fr: "Nombre", en: "Count" }, kind: "number", default: "6" },
      { key: "angle", label: { fr: "Angle total", en: "Total angle" }, kind: "angle", default: "360" },
    ],
  },
];

const features: FeatureDefinition[] = [
  {
    type: "box",
    label: { fr: "Boîte", en: "Box" },
    icon: ICONS.box,
    params: [
      operation,
      { key: "width", label: { fr: "Largeur (X)", en: "Width (X)" }, kind: "length", default: "100" },
      { key: "depth", label: { fr: "Profondeur (Y)", en: "Depth (Y)" }, kind: "length", default: "60" },
      { key: "height", label: { fr: "Hauteur (Z)", en: "Height (Z)" }, kind: "length", default: "40" },
      ...position,
    ],
  },
  {
    type: "cylinder",
    label: { fr: "Cylindre", en: "Cylinder" },
    icon: ICONS.cylinder,
    params: [
      operation,
      { key: "radius", label: { fr: "Rayon", en: "Radius" }, kind: "length", default: "15" },
      { key: "height", label: { fr: "Hauteur", en: "Height" }, kind: "length", default: "40" },
      {
        key: "axis",
        label: { fr: "Axe", en: "Axis" },
        kind: "enum",
        default: "z",
        options: (["x", "y", "z"] as const).map((a) => ({ value: a, label: { fr: a.toUpperCase(), en: a.toUpperCase() } })),
      },
      ...position,
    ],
  },
  {
    type: "fillet",
    label: { fr: "Congé", en: "Fillet" },
    icon: ICONS.fillet,
    params: [{ key: "radius", label: { fr: "Rayon", en: "Radius" }, kind: "length", default: "3" }],
    refs: {
      kind: "edge",
      label: { fr: "Arêtes", en: "Edges" },
      hint: { fr: "Cliquez les arêtes dans la vue. Aucune arête : toutes les arêtes.", en: "Click edges in the view. No edge: all edges." },
    },
  },
  {
    type: "chamfer",
    label: { fr: "Chanfrein", en: "Chamfer" },
    icon: ICONS.chamfer,
    params: [{ key: "distance", label: { fr: "Distance", en: "Distance" }, kind: "length", default: "2" }],
    refs: {
      kind: "edge",
      label: { fr: "Arêtes", en: "Edges" },
      hint: { fr: "Cliquez les arêtes dans la vue. Aucune arête : toutes les arêtes.", en: "Click edges in the view. No edge: all edges." },
    },
  },
  {
    type: "shell",
    label: { fr: "Coque", en: "Shell" },
    icon: ICONS.shell,
    params: [
      { key: "thickness", label: { fr: "Épaisseur", en: "Thickness" }, kind: "length", default: "2" },
      {
        key: "direction",
        label: { fr: "Côté", en: "Side" },
        kind: "enum",
        default: "inside",
        options: [
          { value: "inside", label: { fr: "Vers l'intérieur", en: "Inside" } },
          { value: "outside", label: { fr: "Vers l'extérieur", en: "Outside" } },
        ],
      },
    ],
    refs: {
      kind: "face",
      label: { fr: "Faces à retirer", en: "Faces to remove" },
      hint: { fr: "Cliquez les faces à ouvrir. Aucune face : coque fermée.", en: "Click the faces to open. No face: closed shell." },
    },
  },
  {
    type: "draft",
    label: { fr: "Dépouille", en: "Draft" },
    icon: ICONS.draft,
    params: [
      { key: "angle", label: { fr: "Angle de dépouille", en: "Draft angle" }, kind: "angle", default: "3" },
      {
        key: "mode",
        label: { fr: "Type", en: "Type" },
        kind: "enum",
        default: "neutral",
        options: [
          { value: "neutral", label: { fr: "Plan neutre", en: "Neutral plane" } },
          { value: "parting", label: { fr: "Ligne de joint (des deux côtés)", en: "Parting line (both sides)" } },
        ],
      },
      {
        key: "neutralFrom",
        label: { fr: "Plan neutre ou de joint", en: "Neutral or parting plane" },
        kind: "enum",
        default: "auto",
        options: [
          // Pull direction deduced from the faces, upward; each face keeps its size at its base, parting line in the
          // middle of the faces.
          { value: "auto", label: { fr: "Automatique (base gardée)", en: "Automatic (base kept)" } },
          { value: "face", label: { fr: "Face plane du corps", en: "Planar face of the body" } },
          { value: "plane", label: { fr: "Plan de base ou de référence", en: "Base or reference plane" } },
        ],
      },
      { key: "plane", label: { fr: "Plan", en: "Plane" }, kind: "plane", default: "XY", when: { key: "neutralFrom", is: ["plane"] } },
      { key: "offset", label: { fr: "Décalage du plan", en: "Plane offset" }, kind: "length", default: "0", when: { key: "neutralFrom", is: ["plane"] } },
      // Parting line: each side narrows away from the plane, the reverse would be an undercut.
      { ...reverse, label: { fr: "Inverser la direction de démoulage", en: "Reverse pull direction" }, when: { key: "mode", is: ["neutral"] } },
    ],
    // Neutral face first: once picked, the clicks go to the faces to draft.
    refGroups: [
      {
        key: "neutral",
        kind: "face",
        label: { fr: "Face neutre", en: "Neutral face" },
        hint: {
          fr: "Cliquez la face plane qui garde ses dimensions : la pièce se rétrécit en s'en éloignant.",
          en: "Click the planar face that keeps its size: the part narrows away from it.",
        },
        min: 1,
        max: 1,
        filter: "solid",
        when: { key: "neutralFrom", is: ["face"] },
      },
      {
        key: "faces",
        kind: "face",
        label: { fr: "Faces à dépouiller", en: "Faces to draft" },
        hint: { fr: "Cliquez les faces à incliner (parois parallèles à la direction de démoulage).", en: "Click the faces to tilt (walls parallel to the pull direction)." },
        min: 1,
        filter: "solid",
      },
    ],
  },
];

/**
 * Reference plane: built on planes, faces, edges or vertices (offset, parallel, midplane, inclined,
 * through an axis, tangent, through three points, normal to an axis). Its construction is in `Feature.datum`,
 * edited by a dedicated panel (the generic parameters are not enough to select the elements).
 */
export const planeFeature: FeatureDefinition = {
  type: "plane",
  label: { fr: "Plan", en: "Plane" },
  icon: svg('<path d="M3 16 8 7h13l-5 9z"/><path d="M12 11.5v-8M10 5.5l2-2 2 2"/>'),
  params: [],
};

const command = (f: FeatureDefinition) => ({
  id: `part.${f.type}`,
  label: f.label,
  icon: f.icon,
  run: (ctx: { beginFeature(type: string): void }) => ctx.beginFeature(f.type),
});

/** Imported body (STEP): created by Fichier › Importer, with no parameter or ribbon button. */
const importFeature: FeatureDefinition = {
  type: "importStep",
  label: { fr: "Corps importé", en: "Imported body" },
  icon: svg('<path d="M12 3v11m-4-4 4 4 4-4"/><path d="M4 15v4h16v-4"/>'),
  params: [],
};

/** Multi-body features: they act on the target body (`Feature.body`, otherwise the active body). */
const bodyFeatures: FeatureDefinition[] = [
  {
    type: "combineBodies",
    label: { fr: "Combiner des corps", en: "Combine bodies" },
    icon: ICONS.combineBodies,
    params: [
      {
        key: "op",
        label: { fr: "Opération", en: "Operation" },
        kind: "enum",
        default: "add",
        options: [
          { value: "add", label: { fr: "Union", en: "Union" } },
          { value: "cut", label: { fr: "Soustraction", en: "Subtract" } },
          { value: "intersect", label: { fr: "Intersection", en: "Intersect" } },
        ],
      },
      { key: "tools", label: { fr: "Corps outils", en: "Tool bodies" }, kind: "bodies", filter: "solid", default: "" },
      yesNo("keep", "Garder les corps outils", "Keep tool bodies"),
    ],
  },
  {
    type: "moveBody",
    label: { fr: "Déplacer un corps", en: "Move body" },
    icon: ICONS.moveBody,
    bodyTarget: "any",
    params: [
      { key: "dx", label: { fr: "Translation X", en: "Translation X" }, kind: "length", default: "0" },
      { key: "dy", label: { fr: "Translation Y", en: "Translation Y" }, kind: "length", default: "0" },
      { key: "dz", label: { fr: "Translation Z", en: "Translation Z" }, kind: "length", default: "0" },
      { key: "axis", label: { fr: "Axe de rotation (par l'origine)", en: "Rotation axis (through origin)" }, kind: "enum", default: "Z", options: axisOptions },
      { key: "angle", label: { fr: "Angle de rotation", en: "Rotation angle" }, kind: "angle", default: "0" },
      yesNo("copy", "Copie (nouveau corps)", "Copy (new body)"),
    ],
  },
  {
    type: "splitBody",
    label: { fr: "Scinder un corps", en: "Split body" },
    icon: ICONS.splitBody,
    params: [
      { key: "plane", label: { fr: "Plan de coupe", en: "Split plane" }, kind: "plane", default: "YZ" },
      { key: "offset", label: { fr: "Décalage du plan", en: "Plane offset" }, kind: "length", default: "0" },
    ],
  },
  {
    type: "deleteBody",
    label: { fr: "Supprimer un corps", en: "Delete body" },
    icon: ICONS.deleteBody,
    bodyTarget: "any",
    params: [],
  },
];

export const partBench: Bench = {
  id: "part",
  label: { fr: "Pièce", en: "Part" },
  features: [...sketchFeatures, ...holeFeatures, profileFeature, ...patternFeatures, ...features, ...bodyFeatures, planeFeature, importFeature],
  ribbon: [
    { label: { fr: "Esquisse", en: "Sketch" }, commands: sketchFeatures.slice(0, 1).map(command) },
    { label: { fr: "Référence", en: "Reference" }, commands: [planeFeature].map(command) },
    { label: { fr: "Depuis une esquisse", en: "From sketch" }, stacked: true, commands: [...sketchFeatures.slice(1), ...holeFeatures, profileFeature].map(command) },
    { label: { fr: "Répétition", en: "Pattern" }, stacked: true, commands: patternFeatures.map(command) },
    { label: { fr: "Primitives", en: "Primitives" }, stacked: true, commands: features.slice(0, 2).map(command) },
    { label: { fr: "Finition", en: "Dress-up" }, stacked: true, commands: features.slice(2).map(command) },
    { label: { fr: "Corps", en: "Bodies" }, stacked: true, commands: bodyFeatures.map(command) },
  ],
};
