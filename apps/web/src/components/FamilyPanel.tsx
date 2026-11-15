import { createSignal, For, Index, Show } from "solid-js";
import { isValidName, type DimensionKind, type PartDocument, type PartFamily } from "@solidus-cad/sdk";
import { t, tx, type TKey } from "../i18n.ts";
import { commit, definitionOf, setMessage, state } from "../store.ts";
import { readXlsx, writeXlsx, type Table } from "../xlsx.ts";
import { saveBlob } from "../files.ts";
import { nonParameterizedDims } from "./partDims.ts";

/** Part family: configurations driving the global parameters, importable and exportable as .xlsx.
 * A part from the standard library keeps its family read-only: changing its size is allowed,
 * but the table (editor content) can be neither downloaded nor modified. */

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const DIM_LABEL: Record<DimensionKind, TKey> = {
  distance: "dim.distance",
  horizontalDistance: "dim.horizontalDistance",
  verticalDistance: "dim.verticalDistance",
  radius: "dim.radius",
  diameter: "dim.diameter",
  angle: "dim.angle",
};

/** Part taken from the standard library (origin stored in the document). */
const fromLibrary = () => !!(state.doc as PartDocument & { source?: { library?: string } }).source?.library;

function toTable(f: PartFamily): Table {
  return [[t("fam.configuration"), ...f.columns], ...f.rows.map((r) => [r.name, ...f.columns.map((_, i) => r.values[i] ?? "")])];
}

function fromTable(table: Table): PartFamily {
  const [header, ...rows] = table;
  if (!header || header.length < 2 || rows.length === 0) throw new Error(t("fam.badFile"));
  const columns = header.slice(1).map((c) => c.trim());
  const invalid = columns.find((c) => !isValidName(c));
  if (invalid !== undefined) throw new Error(`${t("fam.badColumn")} « ${invalid} »`);
  return {
    columns,
    rows: rows.map((r, i) => ({ name: r[0]?.trim() || `${t("fam.configuration")} ${i + 1}`, values: columns.map((_, c) => (r[c + 1] ?? "").trim()) })),
    active: 0,
  };
}

function setFamily(f: PartFamily | undefined): void {
  commit((d) => {
    if (f) d.family = f;
    else delete d.family;
  });
}

function importXlsx(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".xlsx";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      setFamily(fromTable(readXlsx(new Uint8Array(await file.arrayBuffer()))));
    } catch (e) {
      setMessage(`${t("fam.importError")} : ${(e as Error).message}`);
    }
  };
  input.click();
}

async function exportXlsx(): Promise<void> {
  const f = state.doc.family;
  if (!f) return;
  try {
    await saveBlob(writeXlsx(toTable(f)), `${state.doc.name}-famille.xlsx`, XLSX_MIME, ".xlsx");
  } catch {
    /* cancelled */
  }
}

/** .xlsx template of the current part: columns for the global parameters, then for the dimensions not driven by a parameter,
 * with their current values. Dimension columns cannot be re-imported as is: they serve as
 * a work list for creating the matching parameters. */
async function downloadTemplate(): Promise<void> {
  const params = state.doc.parameters;
  const dims = nonParameterizedDims(state.doc, definitionOf, tx, (k) => t(DIM_LABEL[k]));
  const table: Table = [
    [t("fam.configuration"), ...params.map((p) => p.name), ...dims.map((d) => d.name)],
    [`${t("fam.configuration")} 1`, ...params.map((p) => p.expr), ...dims.map((d) => d.value)],
  ];
  try {
    await saveBlob(writeXlsx(table), `${state.doc.name}-modele.xlsx`, XLSX_MIME, ".xlsx");
  } catch {
    /* cancelled */
  }
}

export function FamilyPanel() {
  const [open, setOpen] = createSignal(false);
  const family = () => state.doc.family;

  const fromParameters = () =>
    setFamily({
      columns: state.doc.parameters.map((p) => p.name),
      rows: [{ name: `${t("fam.configuration")} 1`, values: state.doc.parameters.map((p) => p.expr) }],
      active: 0,
    });

  const setCell = (row: number, col: number, value: string) =>
    commit((d) => {
      const r = d.family?.rows[row];
      if (!r) return;
      if (col < 0) r.name = value.trim() || r.name;
      else r.values[col] = value.trim();
    });

  return (
    <div class="tree-section">
      <button class="tree-section-title" onClick={() => setOpen(!open())}>
        <span class="chevron" classList={{ open: open() }}>
          ▸
        </span>
        {t("fam.title")}
        <span class="count">{family()?.rows.length ?? 0}</span>
      </button>
      <Show when={open()}>
        <Show
          when={family()}
          fallback={
            <div class="family-actions">
              <button class="link-btn" onClick={fromParameters} disabled={state.doc.parameters.length === 0}>
                + {t("fam.fromParams")}
              </button>
              <button class="link-btn" title={t("fam.templateTitle")} onClick={() => void downloadTemplate()}>
                ⇩ {t("fam.template")}
              </button>
              <button class="link-btn" onClick={importXlsx}>
                ⇪ {t("fam.import")}
              </button>
            </div>
          }
        >
          {(f) => (
            <>
              <label class="field family-active">
                <span>{t("fam.active")}</span>
                <select value={f().active} onChange={(e) => commit((d) => void (d.family!.active = Number(e.currentTarget.value)))}>
                  <For each={f().rows}>{(r, i) => <option value={i()}>{r.name}</option>}</For>
                </select>
              </label>
              <div class="family-table-wrap">
                <table class="family-table">
                  <thead>
                    <tr>
                      <th>{t("fam.configuration")}</th>
                      <For each={f().columns}>{(c) => <th>{c}</th>}</For>
                    </tr>
                  </thead>
                  <tbody>
                    <Index each={f().rows}>
                      {(r, ri) => (
                        <tr classList={{ active: ri === f().active }}>
                          <td>
                            <input value={r().name} disabled={fromLibrary()} onChange={(e) => setCell(ri, -1, e.currentTarget.value)} aria-label={t("fam.configuration")} />
                          </td>
                          <Index each={f().columns}>
                            {(c, ci) => (
                              <td>
                                <input value={r().values[ci] ?? ""} disabled={fromLibrary()} onChange={(e) => setCell(ri, ci, e.currentTarget.value)} aria-label={c()} />
                              </td>
                            )}
                          </Index>
                        </tr>
                      )}
                    </Index>
                  </tbody>
                </table>
              </div>
              <Show when={fromLibrary()} fallback={
                <div class="family-actions">
                  <button
                    class="link-btn"
                    onClick={() =>
                      commit((d) => {
                        const last = d.family!.rows[d.family!.rows.length - 1]!;
                        d.family!.rows.push({ name: `${t("fam.configuration")} ${d.family!.rows.length + 1}`, values: [...last.values] });
                      })
                    }
                  >
                    + {t("fam.addRow")}
                  </button>
                  <button class="link-btn" onClick={importXlsx}>
                    ⇪ {t("fam.import")}
                  </button>
                  <button class="link-btn" onClick={() => void exportXlsx()}>
                    ⇩ {t("fam.export")}
                  </button>
                  <button class="link-btn danger" onClick={() => setFamily(undefined)}>
                    {t("tree.delete")}
                  </button>
                </div>
              }>
                <span class="field-hint">{t("fam.library")}</span>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
