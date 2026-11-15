import { createSignal } from "solid-js";
import { strToU8 } from "fflate";
import type { FlatPattern } from "@solidus-cad/sdk";
import { computeFlatPattern, setMessage, state } from "../store.ts";
import { saveBlob } from "../files.ts";
import { t } from "../i18n.ts";

/** Flat pattern of the active sheet metal (preview dialog and DXF export). */
export const [flatView, setFlatView] = createSignal<{ pattern: FlatPattern; name: string } | null>(null);

export async function openFlatPattern(): Promise<void> {
  try {
    const pattern = await computeFlatPattern(state.doc);
    setFlatView({ pattern, name: state.doc.name });
  } catch (e) {
    setMessage((e as Error).message);
  }
}

const n = (v: number) => Math.round(v * 1e4) / 1e4;

export function bendLabel(b: FlatPattern["bends"][number], lang: "fr" | "en" = "fr"): string {
  const dir = lang === "fr" ? (b.up ? "HAUT" : "BAS") : b.up ? "UP" : "DOWN";
  return `${dir} ${Math.round(b.angle * 10) / 10}°`;
}

/**
 * R12 DXF of the flat pattern: CONTOUR layer (cut), BEND layer (bend lines as dashes, direction and angle),
 * INFO layer (thickness, radius, K-factor). Units: mm.
 */
export function flatDxf(f: FlatPattern, name: string): string {
  const out: (string | number)[] = [];
  const g = (code: number, value: string | number) => out.push(code, value);
  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$ACADVER");
  g(1, "AC1009");
  g(9, "$INSUNITS");
  g(70, 4);
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "TABLES");
  g(0, "TABLE");
  g(2, "LTYPE");
  g(70, 2);
  for (const [lt, desc, pattern] of [
    ["CONTINUOUS", "Solid line", []],
    ["DASHED", "Dashed __ __ __", [4, -2]],
  ] as [string, string, number[]][]) {
    g(0, "LTYPE");
    g(2, lt);
    g(70, 0);
    g(3, desc);
    g(72, 65);
    g(73, pattern.length);
    g(40, pattern.reduce((s, x) => s + Math.abs(x), 0));
    for (const p of pattern) g(49, p);
  }
  g(0, "ENDTAB");
  g(0, "TABLE");
  g(2, "LAYER");
  g(70, 3);
  for (const [layer, color, lt] of [
    ["CONTOUR", 7, "CONTINUOUS"],
    ["PLIAGE", 1, "DASHED"],
    ["INFO", 3, "CONTINUOUS"],
  ] as const) {
    g(0, "LAYER");
    g(2, layer);
    g(70, 0);
    g(62, color);
    g(6, lt);
  }
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "ENTITIES");
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => {
    g(0, "LINE");
    g(8, layer);
    g(10, n(x1));
    g(20, n(y1));
    g(30, 0);
    g(11, n(x2));
    g(21, n(y2));
    g(31, 0);
  };
  const text = (layer: string, x: number, y: number, h: number, s: string, angle = 0) => {
    g(0, "TEXT");
    g(8, layer);
    g(10, n(x));
    g(20, n(y));
    g(30, 0);
    g(40, h);
    g(1, s);
    if (angle) g(50, n(angle));
  };
  const o = f.outline;
  for (let i = 0; i + 3 < o.length; i += 4) line("CONTOUR", o[i]!, o[i + 1]!, o[i + 2]!, o[i + 3]!);
  const size = Math.max(f.bounds[2] - f.bounds[0], f.bounds[3] - f.bounds[1]);
  const h = Math.max(size / 80, 1.5);
  for (const b of f.bends) {
    line("PLIAGE", b.x1, b.y1, b.x2, b.y2);
    const angle = (Math.atan2(b.y2 - b.y1, b.x2 - b.x1) * 180) / Math.PI;
    const upright = angle > 90 || angle < -90 ? angle + 180 : angle;
    text("PLIAGE", (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2 + h * 0.4, h, bendLabel(b), upright);
  }
  text("INFO", f.bounds[0], f.bounds[1] - h * 2.5, h, `${name} - EP ${f.thickness} mm - R ${f.radius} mm - K ${f.kFactor}`);
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n") + "\n";
}

export async function exportFlatDxf(f: FlatPattern, name: string): Promise<void> {
  try {
    await saveBlob(strToU8(flatDxf(f, name)), `${name}-developpe.dxf`, "application/dxf", ".dxf");
    setMessage(t("status.saved"));
  } catch {
    /* cancelled */
  }
}
