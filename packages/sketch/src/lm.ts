/** Dense linear algebra tools for the small least-squares solvers (Levenberg-Marquardt). */

/** Solves A x = b (partial pivoting); null if A is singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-18) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const k = M[r]![c]! / M[c]![c]!;
      for (let k2 = c; k2 <= n; k2++) M[r]![k2] = M[r]![k2]! - k * M[c]![k2]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** Numerical rank of an m×n matrix (Gaussian elimination with a relative threshold). */
export function rank(J: number[][], n: number): number {
  const M = J.map((r) => [...r]);
  let rk = 0;
  let maxAbs = 1e-12;
  for (const row of M) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  for (let c = 0; c < n && rk < M.length; c++) {
    let p = rk;
    for (let r = rk + 1; r < M.length; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-7 * maxAbs) continue;
    [M[rk], M[p]] = [M[p]!, M[rk]!];
    for (let r = rk + 1; r < M.length; r++) {
      const k = M[r]![c]! / M[rk]![c]!;
      for (let k2 = c; k2 < n; k2++) M[r]![k2] = M[r]![k2]! - k * M[rk]![k2]!;
    }
    rk++;
  }
  return rk;
}

/**
 * Minimizes ‖f(x)‖² by Levenberg-Marquardt.
 * `jacobian(x, f)` returns J (row = residual, column = variable).
 */
export function levenbergMarquardt(
  x0: number[],
  residuals: (x: number[]) => number[],
  jacobian: (x: number[], f: number[]) => number[][],
  maxIter = 100,
): { x: number[]; f: number[]; cost: number } {
  const n = x0.length;
  let x = [...x0];
  let f = residuals(x);
  const norm2 = (v: number[]) => v.reduce((s, e) => s + e * e, 0);
  let cost = norm2(f);
  let lambda = 1e-3;
  for (let iter = 0; iter < maxIter && n > 0 && cost > 1e-20; iter++) {
    const J = jacobian(x, f);
    // (JᵀJ + λ diag) δ = −Jᵀ f
    const JtJ = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const Jtf = new Array<number>(n).fill(0);
    J.forEach((row, i) => {
      for (let a = 0; a < n; a++) {
        const ra = row[a]!;
        if (ra === 0) continue;
        Jtf[a] = Jtf[a]! + ra * f[i]!;
        for (let b = 0; b < n; b++) if (row[b] !== 0) JtJ[a]![b] = JtJ[a]![b]! + ra * row[b]!;
      }
    });
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (v + 1e-9) + 1e-12 : v)));
      const delta = solveLinear(A, Jtf.map((v) => -v));
      if (!delta) break;
      const xn = x.map((v, i) => v + delta[i]!);
      const fn = residuals(xn);
      const cn = norm2(fn);
      if (cn < cost) {
        x = xn;
        f = fn;
        cost = cn;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { x, f, cost };
}
