/**
 * Catalog of profiles (standard sections), in mm.
 * Sections centered on the origin: u horizontal (width), v vertical (height).
 * Known simplifications: root fillets and flange tapers are ignored; aluminium slot profiles are simplified.
 */

export type Loop2D = { kind: "polygon"; pts: [number, number][] } | { kind: "circle"; c: [number, number]; r: number };

export interface Section {
  outer: Loop2D;
  holes: Loop2D[];
}

export interface SectionFamily {
  id: string;
  label: { fr: string; en: string };
  sizes: string[];
  build(size: string): Section;
}

const rect = (w: number, h: number, cx = 0, cy = 0): Loop2D => ({
  kind: "polygon",
  pts: [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ],
});

/** I-beam profile: height h, width b, web tw, flanges tf. */
function iBeam(h: number, b: number, tw: number, tf: number): Section {
  const x = b / 2;
  const y = h / 2;
  const w = tw / 2;
  return {
    outer: {
      kind: "polygon",
      pts: [
        [-x, -y],
        [x, -y],
        [x, -y + tf],
        [w, -y + tf],
        [w, y - tf],
        [x, y - tf],
        [x, y],
        [-x, y],
        [-x, y - tf],
        [-w, y - tf],
        [-w, -y + tf],
        [-x, -y + tf],
      ],
    },
    holes: [],
  };
}

const IPE: Record<string, [number, number, number, number]> = {
  "80": [80, 46, 3.8, 5.2],
  "100": [100, 55, 4.1, 5.7],
  "120": [120, 64, 4.4, 6.3],
  "140": [140, 73, 4.7, 6.9],
  "160": [160, 82, 5, 7.4],
  "180": [180, 91, 5.3, 8],
  "200": [200, 100, 5.6, 8.5],
  "220": [220, 110, 5.9, 9.2],
  "240": [240, 120, 6.2, 9.8],
  "270": [270, 135, 6.6, 10.2],
  "300": [300, 150, 7.1, 10.7],
};

const HEA: Record<string, [number, number, number, number]> = {
  "100": [96, 100, 5, 8],
  "120": [114, 120, 5, 8],
  "140": [133, 140, 5.5, 8.5],
  "160": [152, 160, 6, 9],
  "180": [171, 180, 6, 9.5],
  "200": [190, 200, 6.5, 10],
  "220": [210, 220, 7, 11],
  "240": [230, 240, 7.5, 12],
  "260": [250, 260, 7.5, 12.5],
  "300": [290, 300, 8.5, 14],
};

/** UPN (parallel flanges): h, b, tw, tf. */
const UPN: Record<string, [number, number, number, number]> = {
  "80": [80, 45, 6, 8],
  "100": [100, 50, 6, 8.5],
  "120": [120, 55, 7, 9],
  "140": [140, 60, 7, 10],
  "160": [160, 65, 7.5, 10.5],
  "180": [180, 70, 8, 11],
  "200": [200, 75, 8.5, 11.5],
};

const ANGLE: Record<string, [number, number]> = {
  "20x3": [20, 3],
  "25x3": [25, 3],
  "30x3": [30, 3],
  "40x4": [40, 4],
  "50x5": [50, 5],
  "60x6": [60, 6],
  "70x7": [70, 7],
  "80x8": [80, 8],
  "100x10": [100, 10],
};

const ROUND_TUBE: Record<string, [number, number]> = {
  "21.3x2": [21.3, 2],
  "26.9x2.3": [26.9, 2.3],
  "33.7x2.6": [33.7, 2.6],
  "42.4x2.6": [42.4, 2.6],
  "48.3x2.9": [48.3, 2.9],
  "60.3x3.2": [60.3, 3.2],
  "76.1x3.2": [76.1, 3.2],
  "88.9x3.2": [88.9, 3.2],
  "114.3x3.6": [114.3, 3.6],
};

const SQUARE_TUBE: Record<string, [number, number]> = {
  "20x2": [20, 2],
  "25x2": [25, 2],
  "30x2": [30, 2],
  "40x3": [40, 3],
  "50x3": [50, 3],
  "60x4": [60, 4],
  "80x4": [80, 4],
  "100x5": [100, 5],
};

/** Rectangular tubes: height, width, thickness (size written as height×width×thickness). */
const RECT_TUBE: Record<string, [number, number, number]> = {
  "40x20x2": [40, 20, 2],
  "50x30x3": [50, 30, 3],
  "60x40x3": [60, 40, 3],
  "80x40x3": [80, 40, 3],
  "100x50x4": [100, 50, 4],
  "120x60x4": [120, 60, 4],
  "150x100x5": [150, 100, 5],
};

/** Flat bars: width × thickness. */
const FLAT: Record<string, [number, number]> = {
  "20x5": [20, 5],
  "30x5": [30, 5],
  "40x5": [40, 5],
  "40x8": [40, 8],
  "50x8": [50, 8],
  "60x10": [60, 10],
  "80x10": [80, 10],
  "100x10": [100, 10],
};

/** Aluminium slot profiles (simplified): side, slot width, depth, central bore. */
const ALU: Record<string, [number, number, number, number]> = {
  "30x30 (rainure 8)": [30, 8, 6, 6.8],
  "40x40 (rainure 8)": [40, 8, 8, 6.8],
  "40x40 (rainure 10)": [40, 10, 9, 8.5],
  "45x45 (rainure 10)": [45, 10, 10, 10],
};

function pick<T>(table: Record<string, T>, size: string): T {
  const v = table[size];
  if (!v) throw new Error(`Taille de profilé inconnue « ${size} »`);
  return v;
}

export const SECTION_FAMILIES: SectionFamily[] = [
  { id: "IPE", label: { fr: "IPE", en: "IPE" }, sizes: Object.keys(IPE), build: (s) => iBeam(...pick(IPE, s)) },
  { id: "HEA", label: { fr: "HEA", en: "HEA" }, sizes: Object.keys(HEA), build: (s) => iBeam(...pick(HEA, s)) },
  {
    id: "UPN",
    label: { fr: "UPN", en: "UPN" },
    sizes: Object.keys(UPN),
    build: (s) => {
      const [h, b, tw, tf] = pick(UPN, s);
      const y = h / 2;
      // Web on the left (u = -b/2), flanges to the right; section re-centered on the middle of the width.
      const x0 = -b / 2;
      return {
        outer: {
          kind: "polygon",
          pts: [
            [x0, -y],
            [x0 + b, -y],
            [x0 + b, -y + tf],
            [x0 + tw, -y + tf],
            [x0 + tw, y - tf],
            [x0 + b, y - tf],
            [x0 + b, y],
            [x0, y],
          ],
        },
        holes: [],
      };
    },
  },
  {
    id: "angle",
    label: { fr: "Cornière à ailes égales", en: "Equal angle" },
    sizes: Object.keys(ANGLE),
    build: (s) => {
      const [a, t] = pick(ANGLE, s);
      const o = -a / 2;
      return {
        outer: {
          kind: "polygon",
          pts: [
            [o, o],
            [o + a, o],
            [o + a, o + t],
            [o + t, o + t],
            [o + t, o + a],
            [o, o + a],
          ],
        },
        holes: [],
      };
    },
  },
  {
    id: "roundTube",
    label: { fr: "Tube rond", en: "Round tube" },
    sizes: Object.keys(ROUND_TUBE),
    build: (s) => {
      const [d, t] = pick(ROUND_TUBE, s);
      return { outer: { kind: "circle", c: [0, 0], r: d / 2 }, holes: [{ kind: "circle", c: [0, 0], r: d / 2 - t }] };
    },
  },
  {
    id: "squareTube",
    label: { fr: "Tube carré", en: "Square tube" },
    sizes: Object.keys(SQUARE_TUBE),
    build: (s) => {
      const [a, t] = pick(SQUARE_TUBE, s);
      return { outer: rect(a, a), holes: [rect(a - 2 * t, a - 2 * t)] };
    },
  },
  {
    id: "rectTube",
    label: { fr: "Tube rectangulaire", en: "Rectangular tube" },
    sizes: Object.keys(RECT_TUBE),
    build: (s) => {
      const [h, b, t] = pick(RECT_TUBE, s);
      return { outer: rect(b, h), holes: [rect(b - 2 * t, h - 2 * t)] };
    },
  },
  {
    id: "flat",
    label: { fr: "Plat", en: "Flat bar" },
    sizes: Object.keys(FLAT),
    build: (s) => {
      const [w, t] = pick(FLAT, s);
      return { outer: rect(w, t), holes: [] };
    },
  },
  {
    id: "alu",
    label: { fr: "Profilé alu à rainures (simplifié)", en: "Aluminium slot profile (simplified)" },
    sizes: Object.keys(ALU),
    build: (s) => {
      const [a, w, d, bore] = pick(ALU, s);
      const h = a / 2;
      const k = w / 2;
      // Square with a rectangular slot in the middle of each side.
      const pts: [number, number][] = [
        [-h, -h],
        [-k, -h],
        [-k, -h + d],
        [k, -h + d],
        [k, -h],
        [h, -h],
        [h, -k],
        [h - d, -k],
        [h - d, k],
        [h, k],
        [h, h],
        [k, h],
        [k, h - d],
        [-k, h - d],
        [-k, h],
        [-h, h],
        [-h, k],
        [-h + d, k],
        [-h + d, -k],
        [-h, -k],
      ];
      return { outer: { kind: "polygon", pts }, holes: [{ kind: "circle", c: [0, 0], r: bore / 2 }] };
    },
  },
];

export function sectionFamily(id: string): SectionFamily | undefined {
  return SECTION_FAMILIES.find((f) => f.id === id);
}

/** Area of a section (check and properties). */
export function sectionArea(s: Section): number {
  const area = (l: Loop2D) => {
    if (l.kind === "circle") return Math.PI * l.r * l.r;
    let a = 0;
    for (let i = 0; i < l.pts.length; i++) {
      const [x1, y1] = l.pts[i]!;
      const [x2, y2] = l.pts[(i + 1) % l.pts.length]!;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  };
  return area(s.outer) - s.holes.reduce((n, h) => n + area(h), 0);
}

/**
 * Mechanical properties of a section (mm, mm², mm⁴, mm³), axes passing through the centroid:
 * - `Iu` = ∫(v − cv)² dA: moment of inertia about the axis parallel to u (strong-axis bending of an IPE);
 * - `Iv` = ∫(u − cu)² dA: moment of inertia about the axis parallel to v;
 * - `Iuv` = ∫(u − cu)(v − cv) dA: product of inertia (non-zero for an angle);
 * - `I1`, `I2`, `angle`: principal moments of inertia and angle (rad) of principal axis 1 from u;
 * - `J`: Saint-Venant torsion constant (thin-wall formulas depending on the family);
 * - `Wu`, `Wv`: elastic section moduli (inertia / distance to the extreme fiber).
 */
export interface SectionProps {
  A: number;
  cu: number;
  cv: number;
  Iu: number;
  Iv: number;
  Iuv: number;
  I1: number;
  I2: number;
  angle: number;
  J: number;
  Wu: number;
  Wv: number;
}

interface Moments {
  a: number;
  su: number;
  sv: number;
  iuu: number;
  ivv: number;
  iuv: number;
}

/** Moments of a loop (positive area whatever the traversal direction), about the origin. */
function loopMoments(l: Loop2D): Moments {
  if (l.kind === "circle") {
    const [cx, cy] = l.c;
    const a = Math.PI * l.r * l.r;
    const k = (l.r * l.r) / 4;
    return { a, su: a * cx, sv: a * cy, iuu: a * (k + cx * cx), ivv: a * (k + cy * cy), iuv: a * cx * cy };
  }
  const m: Moments = { a: 0, su: 0, sv: 0, iuu: 0, ivv: 0, iuv: 0 };
  const n = l.pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = l.pts[i]!;
    const [x2, y2] = l.pts[(i + 1) % n]!;
    const c = x1 * y2 - x2 * y1;
    m.a += c / 2;
    m.su += ((x1 + x2) * c) / 6;
    m.sv += ((y1 + y2) * c) / 6;
    m.iuu += ((x1 * x1 + x1 * x2 + x2 * x2) * c) / 12;
    m.ivv += ((y1 * y1 + y1 * y2 + y2 * y2) * c) / 12;
    m.iuv += ((x1 * y2 + 2 * x1 * y1 + 2 * x2 * y2 + x2 * y1) * c) / 24;
  }
  if (m.a < 0) for (const k of Object.keys(m) as (keyof Moments)[]) m[k] = -m[k];
  return m;
}

/** Maximum distance from the outer contour to the center `c`, along u (`axis` 0) or v (`axis` 1). */
function extent(s: Section, axis: 0 | 1, c: number): number {
  const l = s.outer;
  if (l.kind === "circle") return Math.abs(l.c[axis] - c) + l.r;
  return Math.max(...l.pts.map((p) => Math.abs(p[axis] - c)));
}

/** Torsion constant depending on the family (thin walls); otherwise, Saint-Venant approximation A⁴ / (4π² Ip). */
function torsionConstant(family: string | undefined, size: string | undefined, A: number, Ip: number): number {
  const fallback = A ** 4 / (4 * Math.PI * Math.PI * Ip);
  if (!family || !size) return fallback;
  const open = (h: number, b: number, tw: number, tf: number) => (2 * b * tf ** 3 + (h - 2 * tf) * tw ** 3) / 3;
  const bredt = (b: number, h: number, t: number) => {
    const am = (b - t) * (h - t);
    return (4 * am * am * t) / (2 * (b - t + h - t));
  };
  switch (family) {
    case "IPE":
      return open(...pick(IPE, size));
    case "HEA":
      return open(...pick(HEA, size));
    case "UPN":
      return open(...pick(UPN, size));
    case "angle": {
      const [a, t] = pick(ANGLE, size);
      return ((2 * a - t) * t ** 3) / 3;
    }
    case "flat": {
      const [w, t] = pick(FLAT, size);
      return (w * t ** 3 * (1 - (0.63 * t) / w)) / 3;
    }
    case "roundTube":
      return Ip; // circular section: exact
    case "squareTube": {
      const [a, t] = pick(SQUARE_TUBE, size);
      return bredt(a, a, t);
    }
    case "rectTube": {
      const [h, b, t] = pick(RECT_TUBE, size);
      return bredt(b, h, t);
    }
    default:
      return fallback;
  }
}

/** Properties of a section; `family` and `size` refine the torsion constant. */
export function sectionPropsOf(s: Section, family?: string, size?: string): SectionProps {
  const m = loopMoments(s.outer);
  for (const h of s.holes) {
    const k = loopMoments(h);
    for (const key of Object.keys(m) as (keyof Moments)[]) m[key] -= k[key];
  }
  const A = m.a;
  const cu = m.su / A;
  const cv = m.sv / A;
  // Transfer to the centroid (Huygens).
  const Iv = m.iuu - A * cu * cu;
  const Iu = m.ivv - A * cv * cv;
  const Iuv = m.iuv - A * cu * cv;
  const mid = (Iu + Iv) / 2;
  const r = Math.hypot((Iu - Iv) / 2, Iuv);
  const angle = Math.abs(Iuv) < 1e-9 * (Iu + Iv) ? 0 : 0.5 * Math.atan2(-2 * Iuv, Iu - Iv);
  return {
    A,
    cu,
    cv,
    Iu,
    Iv,
    Iuv,
    I1: mid + r,
    I2: mid - r,
    angle,
    J: torsionConstant(family, size, A, Iu + Iv),
    Wu: Iu / extent(s, 1, cv),
    Wv: Iv / extent(s, 0, cu),
  };
}

/** Properties of a profile from the catalog. */
export function sectionProps(family: string, size: string): SectionProps {
  const f = sectionFamily(family);
  if (!f) throw new Error(`Famille de profilé inconnue « ${family} »`);
  return sectionPropsOf(f.build(size), family, size);
}
