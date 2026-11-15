import { createSignal } from "solid-js";
import { evaluate, isConstantExpr, isPlainNumber, splitUnitNumber } from "@solidus-cad/sdk";

/**
 * Display unit for lengths (user preference, every document). Models, documents and exports stay in mm:
 * in inches, a typed value is stored with its suffix (`"2 in"`, evaluated in mm by the SDK evaluator),
 * and displayed values are converted.
 */
export type LengthUnit = "mm" | "in";

const KEY = "cad.units";
const FKEY = "cad.units.frac";
export const MM_PER_INCH = 25.4;

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

const [lengthUnit, setUnitSignal] = createSignal<LengthUnit>(read(KEY) === "in" ? "in" : "mm");
const [inchFractions, setFracSignal] = createSignal(read(FKEY) === "1");
export { inchFractions, lengthUnit };

export function setLengthUnit(u: LengthUnit): void {
  setUnitSignal(u);
  write(KEY, u);
}
export const toggleLengthUnit = () => setLengthUnit(lengthUnit() === "mm" ? "in" : "mm");
export function setInchFractions(on: boolean): void {
  setFracSignal(on);
  write(FKEY, on ? "1" : "0");
}

export const isInch = () => lengthUnit() === "in";

/**
 * Drafting standard of new drawings (user preference, Settings › User): ISO or US (ASME Y14). Until chosen,
 * it follows the length unit (inches → ASME). An existing drawing changes standard in its own panel.
 */
export type DraftingStandard = "ISO" | "ASME";
const SKEY = "cad.drawing.standard";
const storedStd = read(SKEY);
const [draftingChoice, setStdSignal] = createSignal<DraftingStandard | null>(storedStd === "ASME" || storedStd === "ISO" ? storedStd : null);
export const draftingStandard = (): DraftingStandard => draftingChoice() ?? (isInch() ? "ASME" : "ISO");
export function setDraftingStandard(s: DraftingStandard): void {
  setStdSignal(s);
  write(SKEY, s);
}
/** Label of the length unit: "mm" or "in". */
export const unitLabel = () => lengthUnit();
/** Replaces "(mm)" in a label with the current unit. */
export const withUnit = (label: string) => label.replace("(mm)", `(${unitLabel()})`);

/** mm → current unit. */
export const toUnit = (mm: number) => (isInch() ? mm / MM_PER_INCH : mm);
/** current unit → mm. */
export const fromUnit = (v: number) => (isInch() ? v * MM_PER_INCH : v);
/** Default decimals of the current unit (2 in mm, 3 in inches). */
export const lenDigits = () => (isInch() ? 3 : 2);
/** Arrow step of a length field, in the current unit. */
export const lenStep = () => (isInch() ? 0.1 : 1);

const roundTo = (v: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Fraction of an inch to the 1/64 (`1 1/4`), or null if `inches` does not fall on a 1/64. */
export function inchFraction(inches: number): string | null {
  const k = Math.round(inches * 64);
  if (Math.abs(inches * 64 - k) > 64e-4) return null;
  const sign = k < 0 ? "-" : "";
  const a = Math.abs(k);
  const whole = Math.floor(a / 64);
  const num = a % 64;
  if (num === 0) return `${sign}${whole}`;
  const g = gcd(num, 64);
  const frac = `${num / g}/${64 / g}`;
  return whole ? `${sign}${whole} ${frac}` : `${sign}${frac}`;
}

export interface LenFormat {
  /** Decimals (default: lenDigits()). */
  digits?: number;
  /** Appends the unit (" mm", " in", or `"` after a fraction). */
  unit?: boolean;
  /** Keeps trailing zeros (drawings). */
  fixed?: boolean;
  /** Number formatting of the browser language (decimal comma…). */
  locale?: boolean;
  /** Allows inch fractions (default: the preference). */
  fractions?: boolean;
}

/** Formats a length given in mm in the current unit. */
export function fmtLen(mm: number, o: LenFormat = {}): string {
  const inch = isInch();
  const v = toUnit(mm);
  if (inch && (o.fractions ?? inchFractions())) {
    const f = inchFraction(v);
    if (f !== null) return o.unit ? `${f}"` : f;
  }
  const digits = o.digits ?? lenDigits();
  const r = roundTo(v, digits);
  const s = o.locale
    ? r.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: o.fixed ? digits : 0 })
    : o.fixed
      ? r.toFixed(digits)
      : String(r);
  return o.unit ? `${s} ${lengthUnit()}` : s;
}

/** Area (mm²) in cm² or in². */
export function fmtArea(mm2: number, digits = 2): string {
  const v = isInch() ? mm2 / MM_PER_INCH ** 2 : mm2 / 100;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits })} ${isInch() ? "in²" : "cm²"}`;
}

/** Volume (mm³) in cm³ or in³; `minDigits`: decimals always shown. */
export function fmtVol(mm3: number, digits = 2, minDigits = 0): string {
  const v = isInch() ? mm3 / MM_PER_INCH ** 3 : mm3 / 1000;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: minDigits })} ${isInch() ? "in³" : "cm³"}`;
}

/** Inertia (kg·mm²) in kg·mm² or kg·in² (the mass stays in kg). */
export function fmtInertia(kgmm2: number, digits = 2): string {
  const v = isInch() ? kgmm2 / MM_PER_INCH ** 2 : kgmm2;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits })} ${isInch() ? "kg·in²" : "kg·mm²"}`;
}

const num = (s: string) => Number(s.trim().replace(",", "."));
const clean = (v: number) => String(roundTo(v, 6));

/**
 * Text shown in a length field for a stored expression: a bare number (mm) is converted to the current unit,
 * `"2 in"` is shown `2` in inches; any other expression is shown as is.
 */
export function decodeLen(expr: string): string {
  if (!isInch()) return expr;
  if (isPlainNumber(expr)) return clean(num(expr) / MM_PER_INCH);
  const u = splitUnitNumber(expr);
  if (u?.unit === "in") return clean(u.value);
  return expr;
}

const FRACTION_ONLY = /^\s*(\d+\s+)?\d+\s*\/\s*\d+\s*$/;

/**
 * Expression stored for a typed length: in inches, a bare number becomes `"n in"`, a fraction `"1 1/4 in"`
 * and a constant expression `"(1/2 + 1) in"`; an expression with a unit or a parameter is stored as is (mm).
 */
export function encodeLen(text: string): string {
  const t = text.trim();
  if (isPlainNumber(t)) {
    const v = clean(num(t));
    return isInch() ? `${v} in` : v;
  }
  if (!isInch() || t === "" || /mm|cm|in|ft|"|\dm\b|\d\s+m\b/.test(t)) return t;
  if (FRACTION_ONLY.test(t)) return `${t.replace(/\s*\/\s*/, "/")} in`;
  if (isConstantExpr(t)) return `(${t}) in`;
  return t;
}

/** Expression of a measured length (mm) rounded in the current unit, for a new dimension. */
export function lenExpr(mm: number): string {
  return isInch() ? `${roundTo(mm / MM_PER_INCH, 3)} in` : String(roundTo(mm, 3));
}

/** Evaluator for the arrows of a length field: value in the current unit. */
export const lenEvaluator =
  (scope: () => ReadonlyMap<string, number>) =>
  (expr: string): { value?: number; error?: string } => {
    try {
      return { value: toUnit(evaluate(encodeLen(expr), scope())) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
