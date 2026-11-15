import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * Minimal reading and writing of .xlsx workbooks (first sheet, values only).
 * Sufficient for part families: a table of headers and values.
 */

export type Table = string[][];

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

/** Column index (0 = A) of a cell reference "B12". */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
}

function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Readable workbook limits (uploaded tables are untrusted: zip bombs, gigantic sheets). */
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
/** Last Excel column (XFD). */
const MAX_COLUMNS = 16_384;
const MAX_CELLS = 2_000_000;

/**
 * Elements `<tag …>…</tag>` or `<tag …/>` of an XML text, in document order, in linear time: no backtracking regular
 * expression on an uploaded file (a sheet of unclosed `<row>` tags made the previous regexes quadratic).
 */
function* elements(xml: string, tag: string): Generator<{ attrs: string; body: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  while ((i = xml.indexOf(open, i)) !== -1) {
    const next = xml[i + open.length];
    if (next !== ">" && next !== "/" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
      i += open.length; // other tag with the same prefix (<rowBreaks>, <col>…)
      continue;
    }
    const gt = xml.indexOf(">", i + open.length);
    if (gt === -1) return;
    const head = xml.slice(i + open.length, gt);
    if (head.endsWith("/")) {
      yield { attrs: head.slice(0, -1), body: "" };
      i = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end === -1) return;
    yield { attrs: head, body: xml.slice(gt + 1, end) };
    i = end + close.length;
  }
}

/** Value of an attribute (`name="…"`), without a regular expression built from the file's content. */
const ATTRS: Record<string, RegExp> = { r: /(?:^|\s)r="([^"]*)"/, t: /(?:^|\s)t="([^"]*)"/, "r:id": /(?:^|\s)r:id="([^"]*)"/, Id: /(?:^|\s)Id="([^"]*)"/, Target: /(?:^|\s)Target="([^"]*)"/ };
function attr(attrs: string, name: keyof typeof ATTRS): string | undefined {
  return ATTRS[name]!.exec(attrs)?.[1];
}

const firstText = (xml: string) => {
  for (const t of elements(xml, "t")) return t.body;
  return undefined;
};

export function readXlsx(data: Uint8Array): Table {
  let unpacked = 0;
  // Only the XML parts of the workbook, within a total size (declared size: fflate does not inflate beyond it).
  const files = unzipSync(data, {
    filter: (f) => {
      if (!/^xl\/.*\.(xml|rels)$/.test(f.name)) return false;
      unpacked += f.originalSize;
      if (unpacked > MAX_UNPACKED_BYTES) throw new Error("Classeur trop volumineux");
      return true;
    },
  });
  const text = (path: string) => (files[path] ? strFromU8(files[path]!) : "");
  const shared = [...elements(text("xl/sharedStrings.xml"), "si")].map((si) => xmlUnescape([...elements(si.body, "t")].map((t) => t.body).join("")));
  // First sheet declared in the workbook.
  let rel: string | undefined;
  for (const s of elements(text("xl/workbook.xml"), "sheet")) {
    rel = attr(s.attrs, "r:id");
    break;
  }
  let target: string | undefined;
  if (rel) for (const r of elements(text("xl/_rels/workbook.xml.rels"), "Relationship")) if (attr(r.attrs, "Id") === rel) target = attr(r.attrs, "Target");
  const sheetPath = target ? "xl/" + target.replace(/^\/?xl\//, "") : "xl/worksheets/sheet1.xml";
  const sheet = text(sheetPath);
  if (!sheet) throw new Error("Feuille introuvable");
  const rows: Table = [];
  let cellCount = 0;
  for (const row of elements(sheet, "row")) {
    const cells: string[] = [];
    for (const c of elements(row.body, "c")) {
      const r = attr(c.attrs, "r");
      const ref = r && /^[A-Z]+\d+$/.test(r) ? r : columnName(cells.length);
      const type = attr(c.attrs, "t");
      let v: string | undefined;
      for (const x of elements(c.body, "v")) {
        v = x.body;
        break;
      }
      let value = "";
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = xmlUnescape(firstText(c.body) ?? "");
      else if (v !== undefined) value = xmlUnescape(v);
      const col = columnIndex(ref);
      if (col >= MAX_COLUMNS) throw new Error(`Colonne hors limites : ${ref}`);
      cells[col] = value;
    }
    cellCount += cells.length;
    if (cellCount > MAX_CELLS) throw new Error("Tableau trop grand");
    rows.push(Array.from(cells, (x) => x ?? ""));
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

export function writeXlsx(table: Table, sheetName = "Famille"): Uint8Array {
  const rowsXml = table
    .map(
      (row, r) =>
        `<row r="${r + 1}">` +
        row
          .map((v, c) => {
            const ref = `${columnName(c)}${r + 1}`;
            return v !== "" && /^-?\d+(\.\d+)?$/.test(v)
              ? `<c r="${ref}"><v>${v}</v></c>`
              : `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
          })
          .join("") +
        `</row>`,
    )
    .join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
