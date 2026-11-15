const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * Increments a numeric text by `delta`: a plain number is added as is,
 * an expression is evaluated and replaced by its result. Returns `null` if the value
 * is neither a number nor an evaluable expression.
 */
export function stepValue(raw: string, delta: number, evalExpr: (expr: string) => { value?: number; error?: string }): string | null {
  const t = raw.trim().replace(",", ".");
  if (t !== "" && !Number.isNaN(Number(t))) return fmt(Number(t) + delta);
  const v = evalExpr(raw).value;
  return v === undefined ? null : fmt(v + delta);
}
