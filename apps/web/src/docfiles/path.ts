/**
 * Document paths, always with "/": absolute on the desktop ("C:/Projets/bati.vasm", "//nas/projets/bati.vasm",
 * "/home/x/bati.vasm"), relative to the project folder root on the web ("sous-ensembles/vis.vpart").
 */

/** Root of a path with "/": "C:/", network share "//nas/projets/", "/", or "" for a relative path. */
function rootOf(p: string): string {
  const share = /^\/\/[^/]+\/[^/]+/.exec(p)?.[0];
  return share ? `${share}/` : (/^[A-Za-z]:\//.exec(p)?.[0] ?? (p.startsWith("/") ? "/" : ""));
}

/** Normalises separators and resolves "." and ".." (without going above the root). */
export function normalize(path: string): string {
  const p = path.replace(/\\/g, "/");
  const drive = rootOf(p);
  const out: string[] = [];
  for (const seg of p.slice(drive.length).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!drive) out.push("..");
    } else out.push(seg);
  }
  return drive + out.join("/");
}

export const dirname = (path: string): string => {
  const p = normalize(path);
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  const head = p.slice(0, i + 1);
  return head === rootOf(p) ? head : p.slice(0, i);
};

export const basename = (path: string): string => normalize(path).split("/").pop() ?? "";

/** Lowercase extension, including the dot (".vpart"), or "". */
export const extname = (path: string): string => /\.[^./]+$/.exec(basename(path))?.[0].toLowerCase() ?? "";

const isAbsolute = (p: string) => rootOf(p) !== "";

/** `rel` resolved from the folder `dir` (an absolute `rel` is kept as is). */
export function join(dir: string, rel: string): string {
  const r = rel.replace(/\\/g, "/");
  if (isAbsolute(r)) return normalize(r);
  return normalize(dir ? `${dir}/${r}` : r);
}

/** Path of `to` seen from the folder `fromDir`; null if no relative path exists (other drive). */
export function relative(fromDir: string, to: string): string | null {
  const a = normalize(fromDir);
  const b = normalize(to);
  const root = (p: string) => rootOf(p).toUpperCase();
  if (root(a) !== root(b)) return null;
  const sa = a.slice(root(a).length).split("/").filter(Boolean);
  const sb = b.slice(root(b).length).split("/").filter(Boolean);
  // Windows is case-insensitive: comparison is case-insensitive for a path with a drive letter or a share.
  const same = (x: string, y: string) => (root(a).length > 1 ? x.toLowerCase() === y.toLowerCase() : x === y);
  let i = 0;
  while (i < sa.length && i < sb.length - 1 && same(sa[i]!, sb[i]!)) i++;
  return [...sa.slice(i).map(() => ".."), ...sb.slice(i)].join("/");
}

/** Same file? (case-insensitive for a Windows path with a drive letter or a share) */
export function samePath(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return rootOf(x).length > 1 ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Deepest folder containing all the files; "" if they share none. */
export function commonDir(paths: string[]): string {
  const dirs = paths.map((p) => dirname(p).split("/"));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
  return first.slice(0, n).join("/") || (n > 0 ? "/" : "");
}

/** Path of an archive entry that stays inside the folder it is extracted to. */
export const isSafeEntry = (path: string): boolean => !/^[\\/]|^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..");

/** Safe file name derived from a document name. */
export function safeFileName(name: string): string {
  const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
  return s || "document";
}
