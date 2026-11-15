/**
 * ISO 286 fits: deviations of a toleranced dimension given by a code (H7, g6, K7...), in mm.
 * Coverage: nominal diameters up to 500 mm, grades IT1 to IT16,
 * holes C D E F G H JS K M N P R S and shafts c d e f g h js k m n p r s.
 */

/** Upper bounds (inclusive) of the size ranges of ISO 286-2 (mm). */
const STEPS = [3, 6, 10, 18, 30, 40, 50, 65, 80, 100, 120, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500];

/** Index of the main range (fundamental tolerances IT) for each fine range. */
const MAIN = [0, 1, 2, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 11, 11, 12, 12];

/** Fundamental tolerances (µm), IT1 to IT16, main ranges ≤3, 3–6, 6–10, 10–18, 18–30, 30–50, 50–80, 80–120, 120–180, 180–250, 250–315, 315–400, 400–500. */
const IT: Record<number, number[]> = {
  1: [0.8, 1, 1, 1.2, 1.5, 1.5, 2, 2.5, 3.5, 4.5, 6, 7, 8],
  2: [1.2, 1.5, 1.5, 2, 2.5, 2.5, 3, 4, 5, 7, 8, 9, 10],
  3: [2, 2.5, 2.5, 3, 4, 4, 5, 6, 8, 10, 12, 13, 15],
  4: [3, 4, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20],
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
  12: [100, 120, 150, 180, 210, 250, 300, 350, 400, 460, 520, 570, 630],
  13: [140, 180, 220, 270, 330, 390, 460, 540, 630, 720, 810, 890, 970],
  14: [250, 300, 360, 430, 520, 620, 740, 870, 1000, 1150, 1300, 1400, 1550],
  15: [400, 480, 580, 700, 840, 1000, 1200, 1400, 1600, 1850, 2100, 2300, 2500],
  16: [600, 750, 900, 1100, 1300, 1600, 1900, 2200, 2500, 2900, 3200, 3600, 4000],
};

/** Fundamental deviations of shafts (µm), per fine range: es for c…h, ei for k…s. */
const SHAFT: Record<string, number[]> = {
  c: [-60, -70, -80, -95, -110, -120, -130, -140, -150, -170, -180, -200, -210, -230, -240, -260, -280, -300, -330, -360, -400, -440, -480],
  d: [-20, -30, -40, -50, -65, -80, -80, -100, -100, -120, -120, -145, -145, -145, -170, -170, -170, -190, -190, -210, -210, -230, -230],
  e: [-14, -20, -25, -32, -40, -50, -50, -60, -60, -72, -72, -85, -85, -85, -100, -100, -100, -110, -110, -125, -125, -135, -135],
  f: [-6, -10, -13, -16, -20, -25, -25, -30, -30, -36, -36, -43, -43, -43, -50, -50, -50, -56, -56, -62, -62, -68, -68],
  g: [-2, -4, -5, -6, -7, -9, -9, -10, -10, -12, -12, -14, -14, -14, -15, -15, -15, -17, -17, -18, -18, -20, -20],
  h: new Array<number>(23).fill(0),
  k: [0, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 5, 5],
  m: [2, 4, 6, 7, 8, 9, 9, 11, 11, 13, 13, 15, 15, 15, 17, 17, 17, 20, 20, 21, 21, 23, 23],
  n: [4, 8, 10, 12, 15, 17, 17, 20, 20, 23, 23, 27, 27, 27, 31, 31, 31, 34, 34, 37, 37, 40, 40],
  p: [6, 12, 15, 18, 22, 26, 26, 32, 32, 37, 37, 43, 43, 43, 50, 50, 50, 56, 56, 62, 62, 68, 68],
  r: [10, 15, 19, 23, 28, 34, 34, 41, 43, 51, 54, 63, 65, 68, 77, 80, 84, 94, 98, 108, 114, 126, 132],
  s: [14, 19, 23, 28, 35, 43, 43, 53, 59, 71, 79, 92, 100, 108, 122, 130, 140, 158, 170, 190, 208, 232, 252],
};

/** Deviations (mm) of a single tolerance class ("H7", "g6"), or null if it is not tabulated. */
export function toleranceClass(nominal: number, code: string): { upper: number; lower: number } | null {
  const m = /^(js|JS|[a-zA-Z])(\d{1,2})$/.exec(code.trim());
  if (!m || !(nominal > 0) || nominal > 500) return null;
  const letter = m[1]!;
  const grade = Number(m[2]);
  const step = STEPS.findIndex((s) => nominal <= s);
  const it = IT[grade]?.[MAIN[step]!];
  if (it === undefined) return null;
  const hole = letter === letter.toUpperCase();
  const l = letter.toLowerCase();
  let upper: number;
  let lower: number;
  if (l === "js") {
    // ±IT/2; an odd value (IT7 to IT11) is rounded down to the even µm.
    const half = grade >= 7 && grade <= 11 && it % 2 === 1 ? (it - 1) / 2 : it / 2;
    [upper, lower] = [half, -half];
  } else {
    const table = SHAFT[l];
    if (!table) return null;
    let fd = table[step]!;
    // k: zero deviation outside grades 4 to 7.
    if (l === "k" && (grade < 4 || grade > 7)) fd = 0;
    if (!hole) {
      if ("cdefgh".includes(l)) [upper, lower] = [fd, fd - it];
      else [upper, lower] = [fd + it, fd];
    } else if ("cdefgh".includes(l)) {
      // Holes A to H: EI = −es.
      [lower, upper] = [-fd, -fd + it];
    } else {
      // Holes K to S: ES = −ei (+ Δ = ITn − ITn−1 for K, M, N ≤ IT8 and P to S ≤ IT7, above 3 mm).
      const prev = IT[grade - 1]?.[MAIN[step]!] ?? 0;
      const withDelta = step > 0 && (("kmn".includes(l) && grade <= 8) || ("prs".includes(l) && grade <= 7));
      let es = -fd + (withDelta ? it - prev : 0);
      if (!withDelta && (l === "k" || l === "n") && grade > 8) es = 0;
      [upper, lower] = [es, es - it];
    }
  }
  // "|| 0": avoids −0 (H, h).
  return { upper: upper / 1000 || 0, lower: lower / 1000 || 0 };
}

/** Deviations of a fit or a class: "H7", "g6" (one class); "H7/g6" (hole, shaft). */
export function fitDeviations(nominal: number, fit: string): { upper: number; lower: number }[] | null {
  const parts = fit.split("/").map((s) => s.trim()).filter(Boolean);
  const out = parts.map((p) => toleranceClass(nominal, p));
  return out.length > 0 && out.every((x) => x) ? (out as { upper: number; lower: number }[]) : null;
}

/** Fundamental tolerance ITn (mm) at the nominal diameter, or null outside the domain (0 < Ø ≤ 500, IT1 to IT16). */
export function itTolerance(nominal: number, grade: number): number | null {
  if (!(nominal > 0) || nominal > 500) return null;
  const step = STEPS.findIndex((s) => nominal <= s);
  const it = IT[grade]?.[MAIN[step]!];
  return it === undefined ? null : it / 1000;
}

/**
 * Equivalent IT grade of a tolerance interval (mm): the largest grade whose IT fits within the interval,
 * i.e. the precision that must actually be held (0.03 on Ø20: IT8 = 0.033 is not enough, so IT7).
 * IT1 if the interval is tighter than IT1; null outside the ISO 286 domain.
 */
export function equivalentGrade(nominal: number, width: number): number | null {
  if (!(width > 0) || itTolerance(nominal, 1) === null) return null;
  let grade = 1;
  for (let g = 1; g <= 16; g++) if (itTolerance(nominal, g)! <= width + 1e-9) grade = g;
  return grade;
}

const HOLE_LETTERS = ["C", "D", "E", "F", "G", "H", "JS", "K", "M", "N", "P", "R", "S"];

/**
 * Tolerance classes whose deviations are exactly (to the µm) those given: "Ø8 −0.005/−0.014" → ["g6"].
 * Used to find the code of a drawing that only states the deviations or the limits.
 */
export function matchClasses(nominal: number, upper: number, lower: number): string[] {
  const out: string[] = [];
  const um = (v: number) => Math.round(v * 1000);
  for (const hole of HOLE_LETTERS) {
    for (const letter of [hole, hole.toLowerCase()]) {
      for (let grade = 1; grade <= 16; grade++) {
        const c = toleranceClass(nominal, `${letter}${grade}`);
        if (c && um(c.upper) === um(upper) && um(c.lower) === um(lower)) out.push(`${letter}${grade}`);
      }
    }
  }
  return out;
}
