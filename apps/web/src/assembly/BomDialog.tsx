import { For, Show } from "solid-js";
import { t } from "../i18n.ts";
import { writeXlsx } from "../xlsx.ts";
import { saveBlob } from "../files.ts";
import { bom, bomTable, exportBomCsv, setWs, ws } from "../workspace.ts";

/** Bill of materials of the active assembly, exportable as .csv and .xlsx. */
export function BomDialog() {
  const fmt = (v: number | null) => (v === null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 3 }));
  const total = () => bom().reduce((n, r) => (r.mass === null ? n : n + r.mass * r.quantity), 0);

  return (
    <Show when={ws.bomOpen && ws.asm}>
      <div class="dialog-backdrop" onClick={() => setWs("bomOpen", false)}>
        <div class="dialog wide" role="dialog" aria-modal="true" aria-label={t("asm.bom")} onClick={(e) => e.stopPropagation()}>
          <h2>
            {t("asm.bom")} — {ws.asm!.name}
          </h2>
          <table class="bom-table">
            <thead>
              <tr>
                <For each={bomTable()[0]}>{(h) => <th>{h}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={bom()}>
                {(r) => (
                  <tr>
                    <td>{r.item}</td>
                    <td>{r.reference}</td>
                    <td>{r.designation}</td>
                    <td>{r.material}</td>
                    <td class="num">{r.quantity}</td>
                    <td class="num">{fmt(r.mass)}</td>
                  </tr>
                )}
              </For>
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>{t("bom.total")}</td>
                <td class="num">{ws.asm!.components.length}</td>
                <td class="num">{fmt(total())}</td>
              </tr>
            </tfoot>
          </table>
          <div class="panel-actions">
            <button class="btn" onClick={() => void exportBomCsv()}>
              ⇩ CSV
            </button>
            <button
              class="btn"
              onClick={() =>
                void saveBlob(writeXlsx(bomTable(), "Nomenclature"), `${ws.asm!.name}-nomenclature.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx").catch(() => {})
              }
            >
              ⇩ XLSX
            </button>
            <button class="btn primary" onClick={() => setWs("bomOpen", false)}>
              OK
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
