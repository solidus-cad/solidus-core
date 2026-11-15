import type { Parameter } from "./document.ts";

/**
 * Expression evaluator for dimensions and parameters.
 * Grammar: numbers, identifiers, + - * / ^, parentheses, functions (sqrt, sin, cos, tan, abs, min, max, round), constant pi.
 * Angles of the trigonometric functions are in degrees.
 * Lengths are in mm. A number or a parenthesised group may carry a unit suffix that converts it
 * to mm: `mm`, `cm`, `m`, `in` (or `"`), `ft`. Examples: `2 in`, `2"`, `(1/2) in`, `10 mm + 1 in`.
 * A fraction directly followed by a suffix is read as one number: `1/4"`, `1 1/4 in`.
 */

export class ExprError extends Error {}

export type Scope = ReadonlyMap<string, number>;

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "unit"; v: number };

/** Length units accepted as suffixes, in mm per unit. */
export const UNIT_MM: Readonly<Record<string, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8 };

const UNIT_RE = /^\s*(mm|cm|m|in|ft|")(?![A-Za-z0-9_])/;
const FRACTION_RE = /^(?:(\d+)[ \t]+)?(\d+)\/(\d+)(?=\s*(?:mm|cm|m|in|ft|")(?![A-Za-z0-9_]))/;

/** True if `expr` is a bare decimal number (dot or comma), without unit or operator. */
export function isPlainNumber(expr: string): boolean {
  return /^\s*[+-]?(\d+([.,]\d*)?|[.,]\d+)(e[+-]?\d+)?\s*$/i.test(expr);
}

/** If `expr` is a number followed by a unit suffix (`2.5 in`), returns its parts. */
export function splitUnitNumber(expr: string): { value: number; unit: string } | null {
  const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(mm|cm|m|in|ft|")\s*$/i.exec(expr);
  if (!m || !(m[2]! in UNIT_MM)) return null;
  return { value: parseFloat(m[1]!), unit: m[2] === '"' ? "in" : m[2]! };
}

/** True if `expr` contains a unit suffix anywhere. */
export function hasUnitSuffix(expr: string): boolean {
  try {
    return tokenize(expr).some((t) => t.t === "unit");
  } catch {
    return false;
  }
}

/** True if `expr` references no identifier other than functions and constants (e.g. `1/2`, `3 + 1/4`). */
export function isConstantExpr(expr: string): boolean {
  try {
    return tokenize(expr).every((t) => t.t !== "id" || t.v in FUNCS || t.v in CONSTS);
  } catch {
    return false;
  }
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
};

const CONSTS: Record<string, number> = { pi: Math.PI };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidName(name: string): boolean {
  return IDENT.test(name) && !(name in FUNCS) && !(name in CONSTS);
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t") {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const f = FRACTION_RE.exec(src.slice(i));
      if (f) {
        const den = parseFloat(f[3]!);
        if (den === 0) throw new ExprError("Division par zéro");
        out.push({ t: "num", v: (f[1] ? parseFloat(f[1]) : 0) + parseFloat(f[2]!) / den });
        i += f[0].length;
      } else {
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
        if (!m) throw new ExprError(`Nombre invalide à la position ${i + 1}`);
        out.push({ t: "num", v: parseFloat(m[0]) });
        i += m[0].length;
      }
      i = unitSuffix(src, i, out);
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else if ("+-*/^(),".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      if (c === ")") i = unitSuffix(src, i, out);
    } else {
      throw new ExprError(`Caractère inattendu « ${c} »`);
    }
  }
  return out;
}

/** Reads an optional unit suffix at `i` (after a number or a `)`); returns the new position. */
function unitSuffix(src: string, i: number, out: Token[]): number {
  const u = UNIT_RE.exec(src.slice(i));
  if (!u) return i;
  out.push({ t: "unit", v: UNIT_MM[u[1]!]! });
  return i + u[0].length;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: Token[],
    private readonly lookup: (name: string) => number,
  ) {}

  parse(): number {
    if (this.toks.length === 0) throw new ExprError("Expression vide");
    const v = this.sum();
    if (this.pos < this.toks.length) throw new ExprError("Expression mal formée");
    return v;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }

  private expect(v: string): void {
    if (!this.isOp(v)) throw new ExprError(`« ${v} » attendu`);
    this.pos++;
  }

  private sum(): number {
    let v = this.product();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.toks[this.pos++] as { v: string }).v;
      const r = this.product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  private product(): number {
    let v = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = (this.toks[this.pos++] as { v: string }).v;
      const r = this.unary();
      if (op === "/" && r === 0) throw new ExprError("Division par zéro");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }

  private unary(): number {
    if (this.isOp("-")) {
      this.pos++;
      return -this.unary();
    }
    if (this.isOp("+")) {
      this.pos++;
      return this.unary();
    }
    return this.power();
  }

  private power(): number {
    const base = this.atom();
    if (this.isOp("^")) {
      this.pos++;
      return base ** this.unary();
    }
    return base;
  }

  private atom(): number {
    const v = this.bareAtom();
    const u = this.peek();
    if (u?.t === "unit") {
      this.pos++;
      return v * u.v;
    }
    return v;
  }

  private bareAtom(): number {
    const t = this.toks[this.pos++];
    if (!t) throw new ExprError("Expression incomplète");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = this.sum();
      this.expect(")");
      return v;
    }
    if (t.t === "id") {
      const fn = FUNCS[t.v];
      if (fn) {
        this.expect("(");
        const args = [this.sum()];
        while (this.isOp(",")) {
          this.pos++;
          args.push(this.sum());
        }
        this.expect(")");
        return fn(...args);
      }
      if (t.v in CONSTS) return CONSTS[t.v]!;
      return this.lookup(t.v);
    }
    throw new ExprError("Expression mal formée");
  }
}

export function evaluate(expr: string, scope: Scope): number {
  const v = new Parser(tokenize(expr), (name) => {
    const x = scope.get(name);
    if (x === undefined) throw new ExprError(`Paramètre inconnu « ${name} »`);
    return x;
  }).parse();
  if (!Number.isFinite(v)) throw new ExprError("Résultat non fini");
  return v;
}

export interface ResolvedParameters {
  scope: Map<string, number>;
  errors: Map<string, string>;
}

/** Evaluates the global parameters regardless of their order, with cycle detection. */
export function resolveParameters(params: readonly Parameter[]): ResolvedParameters {
  const byName = new Map(params.map((p) => [p.name, p]));
  const scope = new Map<string, number>();
  const errors = new Map<string, string>();
  const visiting = new Set<string>();

  const resolve = (name: string): number => {
    const known = scope.get(name);
    if (known !== undefined) return known;
    if (errors.has(name)) throw new ExprError(`Paramètre « ${name} » en erreur`);
    const p = byName.get(name);
    if (!p) throw new ExprError(`Paramètre inconnu « ${name} »`);
    if (visiting.has(name)) throw new ExprError(`Dépendance circulaire sur « ${name} »`);
    visiting.add(name);
    try {
      const v = new Parser(tokenize(p.expr), resolve).parse();
      if (!Number.isFinite(v)) throw new ExprError("Résultat non fini");
      scope.set(name, v);
      return v;
    } finally {
      visiting.delete(name);
    }
  };

  for (const p of params) {
    try {
      resolve(p.name);
    } catch (e) {
      errors.set(p.name, (e as Error).message);
    }
  }
  return { scope, errors };
}
