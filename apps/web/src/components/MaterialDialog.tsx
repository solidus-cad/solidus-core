import { createSignal, For, Show } from "solid-js";
import { MATERIAL_FAMILIES, type Material, type MaterialFamily } from "@solidus-cad/sdk";
import { t, tx, type TKey } from "../i18n.ts";
import { materialNameTaken, removeCustomMaterial, saveCustomMaterial } from "../materials.ts";
import { setMaterial, state } from "../store.ts";

type NumKey = "density" | "young" | "poisson" | "yieldStrength" | "tensileStrength" | "expansion" | "conductivity";

export const MATERIAL_FIELDS: { key: NumKey; label: TKey; unit: string }[] = [
  { key: "density", label: "mat.density", unit: "g/cm³" },
  { key: "young", label: "mat.young", unit: "GPa" },
  { key: "poisson", label: "mat.poisson", unit: "" },
  { key: "yieldStrength", label: "mat.yield", unit: "MPa" },
  { key: "tensileStrength", label: "mat.tensile", unit: "MPa" },
  { key: "expansion", label: "mat.expansion", unit: "µm/(m·K)" },
  { key: "conductivity", label: "mat.conductivity", unit: "W/(m·K)" },
];

interface Editing {
  draft: Material;
  /** Name of the custom material being edited; absent for a new material. */
  previous?: string;
}

const [editing, setEditing] = createSignal<Editing | null>(null);

/** Opens the editor: new material from `initial`, or editing of the custom material `previous`. */
export function openMaterialEditor(initial: Material, previous?: string): void {
  setEditing({ draft: { ...initial }, previous });
}

export function MaterialDialog() {
  return (
    <Show when={editing()} keyed>
      {(e) => {
        const [draft, setDraft] = createSignal<Material>(e.draft);
        const patch = (p: Partial<Material>) => setDraft({ ...draft(), ...p });
        const name = () => draft().name.trim();
        const error = (): string | null => {
          if (!name()) return t("mat.nameRequired");
          if (materialNameTaken(name(), e.previous)) return t("mat.nameTaken");
          if (!(draft().density > 0)) return t("mat.densityRequired");
          return null;
        };
        const close = () => setEditing(null);
        const submit = () => {
          if (error()) return;
          const m: Material = { ...draft(), name: name() };
          for (const f of MATERIAL_FIELDS) if (m[f.key] === undefined || Number.isNaN(m[f.key])) delete m[f.key];
          saveCustomMaterial(m, e.previous);
          // New material: assigned to the part; modified material: the part using it follows.
          if (!e.previous || state.doc.material?.name === e.previous) setMaterial(m);
          close();
        };
        const remove = () => {
          removeCustomMaterial(e.previous!);
          close();
        };

        return (
          <div class="dialog-backdrop" onClick={close}>
            <form
              class="dialog material-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={e.previous ? t("mat.edit") : t("mat.new")}
              onClick={(ev) => ev.stopPropagation()}
              onKeyDown={(ev) => {
                ev.stopPropagation();
                if (ev.key === "Escape") close();
              }}
              onSubmit={(ev) => {
                ev.preventDefault();
                submit();
              }}
            >
              <h2>{e.previous ? t("mat.edit") : t("mat.new")}</h2>
              <div class="material-form">
                <label class="field wide">
                  <span>{t("mat.name")}</span>
                  <input value={draft().name} onInput={(ev) => patch({ name: ev.currentTarget.value })} ref={(el) => queueMicrotask(() => el.select())} />
                </label>
                <label class="field">
                  <span>{t("mat.family")}</span>
                  <select value={draft().family ?? ""} onChange={(ev) => patch({ family: (ev.currentTarget.value || undefined) as MaterialFamily | undefined })}>
                    <option value="">—</option>
                    <For each={MATERIAL_FAMILIES}>{(f) => <option value={f.id}>{tx(f.label)}</option>}</For>
                  </select>
                </label>
                <label class="field">
                  <span>{t("mat.color")}</span>
                  <input type="color" value={draft().color ?? state.doc.appearance.color} onInput={(ev) => patch({ color: ev.currentTarget.value })} />
                </label>
                <For each={MATERIAL_FIELDS}>
                  {(f) => (
                    <label class="field">
                      <span>
                        {t(f.label)}
                        {f.unit ? ` (${f.unit})` : ""}
                      </span>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        required={f.key === "density"}
                        value={draft()[f.key] ?? ""}
                        onInput={(ev) => {
                          const v = ev.currentTarget.value;
                          patch({ [f.key]: v === "" ? undefined : Number(v) });
                        }}
                      />
                    </label>
                  )}
                </For>
              </div>
              <small class="field-hint">{t("mat.localHint")}</small>
              <Show when={error()}>
                <small class="field-error" role="alert">
                  {error()}
                </small>
              </Show>
              <div class="dialog-actions">
                <Show when={e.previous}>
                  <button type="button" class="btn danger" onClick={remove}>
                    {t("tree.delete")}
                  </button>
                  <span class="spacer" />
                </Show>
                <button type="button" class="btn" onClick={close}>
                  {t("prop.cancel")}
                </button>
                <button type="submit" class="btn primary" disabled={!!error()}>
                  {t("cmd.save")}
                </button>
              </div>
            </form>
          </div>
        );
      }}
    </Show>
  );
}
