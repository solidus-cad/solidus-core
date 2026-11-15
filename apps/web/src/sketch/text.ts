import opentype from "opentype.js";
import regularUrl from "../assets/fonts/LiberationSans-Regular.ttf?url";
import boldUrl from "../assets/fonts/LiberationSans-Bold.ttf?url";

/**
 * Sketch text: glyph outlines (Liberation Sans 1.07, Liberation Fonts license: GPL-2.0 with a font exception, see
 * THIRD_PARTY_LICENSES) reduced to closed polygons,
 * which the session turns into ordinary lines — the text is extruded like any other profile.
 */

export interface TextStyle {
  /** Cap height (mm). */
  height: number;
  bold: boolean;
}

type Pt = { x: number; y: number };

const fonts = new Map<string, Promise<opentype.Font>>();

function loadFont(bold: boolean): Promise<opentype.Font> {
  const url = bold ? boldUrl : regularUrl;
  let f = fonts.get(url);
  if (!f) {
    f = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => opentype.parse(b));
    fonts.set(url, f);
  }
  return f;
}

const CURVE_STEPS = 6;
const LINE_SPACING = 1.4;

/** Closed outlines of the text, in the sketch frame (origin: start of the baseline of the 1st line). */
export async function textContours(text: string, style: TextStyle): Promise<Pt[][]> {
  const font = await loadFont(style.bold);
  const cap = font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7;
  const size = (style.height * font.unitsPerEm) / cap;
  const out: Pt[][] = [];
  text.split(/\r?\n/).forEach((line, row) => {
    if (!line.trim()) return;
    const dy = -row * style.height * LINE_SPACING;
    let cur: Pt[] = [];
    let at: Pt = { x: 0, y: 0 };
    const flush = () => {
      const poly = cur.filter((p, i) => i === 0 || Math.hypot(p.x - cur[i - 1]!.x, p.y - cur[i - 1]!.y) > 1e-6);
      while (poly.length > 1 && Math.hypot(poly[0]!.x - poly.at(-1)!.x, poly[0]!.y - poly.at(-1)!.y) <= 1e-6) poly.pop();
      if (poly.length >= 3) out.push(poly);
      cur = [];
    };
    // opentype: y downwards; the sketch has y upwards.
    const P = (x: number, y: number): Pt => ({ x, y: dy - y });
    for (const c of font.getPath(line, 0, 0, size).commands) {
      if (c.type === "M") {
        flush();
        at = P(c.x, c.y);
        cur = [at];
      } else if (c.type === "L") {
        at = P(c.x, c.y);
        cur.push(at);
      } else if (c.type === "Q") {
        const c1 = P(c.x1, c.y1);
        const e = P(c.x, c.y);
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const u = i / CURVE_STEPS;
          const a = (1 - u) ** 2;
          const b = 2 * (1 - u) * u;
          const d = u * u;
          cur.push({ x: a * at.x + b * c1.x + d * e.x, y: a * at.y + b * c1.y + d * e.y });
        }
        at = e;
      } else if (c.type === "C") {
        const c1 = P(c.x1, c.y1);
        const c2 = P(c.x2, c.y2);
        const e = P(c.x, c.y);
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const u = i / CURVE_STEPS;
          const a = (1 - u) ** 3;
          const b = 3 * (1 - u) ** 2 * u;
          const d = 3 * (1 - u) * u * u;
          const g = u ** 3;
          cur.push({ x: a * at.x + b * c1.x + d * c2.x + g * e.x, y: a * at.y + b * c1.y + d * c2.y + g * e.y });
        }
        at = e;
      } else flush(); // Z
    }
    flush();
  });
  return out;
}
