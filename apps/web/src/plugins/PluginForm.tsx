import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import type { FormField, FormValues } from "@solidus-cad/sdk";
import { t, tx } from "../i18n.ts";
import { fromUnit, toUnit, unitLabel } from "../units.ts";

/** Modal form requested by a plugin (`ctx.ui.form`), rendered with the application's components. */

interface FormSpec {
  title: string;
  fields: FormField[];
  resolve: (v: FormValues | null) => void;
}

const [form, setForm] = createSignal<FormSpec | null>(null);

const initial = (f: FormField): number | string | boolean =>
  f.kind === "boolean" ? (f.default ?? false) : f.kind === "text" ? (f.default ?? "") : f.kind === "enum" ? (f.default ?? f.options[0]?.value ?? "") : (f.default ?? 0);

export function openPluginForm(title: string, fields: FormField[]): Promise<FormValues | null> {
  form()?.resolve(null);
  return new Promise((resolve) =>
    setForm({
      title: String(title),
      fields,
      resolve: (v) => {
        setForm(null);
        resolve(v);
      },
    }),
  );
}

export function PluginForm() {
  return (
    <Show when={form()} keyed>
      {(f) => {
        const [values, setValues] = createStore<FormValues>(Object.fromEntries(f.fields.map((x) => [x.key, initial(x)])));
        const invalid = () =>
          f.fields.some((x) => {
            if (x.kind !== "number" && x.kind !== "length" && x.kind !== "angle") return false;
            const v = values[x.key] as number;
            return !Number.isFinite(v) || (x.min !== undefined && v < x.min) || (x.max !== undefined && v > x.max);
          });
        const ok = () => !invalid() && f.resolve({ ...values });
        return (
          <div class="dialog-backdrop" onClick={() => f.resolve(null)}>
            <div
              class="dialog plugin-form"
              role="dialog"
              aria-modal="true"
              aria-label={f.title}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") f.resolve(null);
                if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") ok();
              }}
            >
              <h2>{f.title}</h2>
              <For each={f.fields}>
                {(x) => (
                  <label class="field">
                    <span>{tx(x.label)}</span>
                    <Switch>
                      <Match when={x.kind === "boolean"}>
                        <input type="checkbox" checked={values[x.key] as boolean} onChange={(e) => setValues(x.key, e.currentTarget.checked)} />
                      </Match>
                      <Match when={x.kind === "enum" && x}>
                        {(e) => (
                          <select value={values[x.key] as string} onChange={(ev) => setValues(x.key, ev.currentTarget.value)}>
                            <For each={(e() as Extract<FormField, { kind: "enum" }>).options}>{(o) => <option value={o.value}>{tx(o.label)}</option>}</For>
                          </select>
                        )}
                      </Match>
                      <Match when={x.kind === "text"}>
                        <input type="text" value={values[x.key] as string} onInput={(e) => setValues(x.key, e.currentTarget.value)} />
                      </Match>
                      <Match when={x.kind === "length"}>
                        <div class="input-unit">
                          <input
                            type="number"
                            // Initial value only (mm → display unit): the field is not rewritten while typing.
                            value={untrack(() => Math.round(toUnit(values[x.key] as number) * 1e6) / 1e6)}
                            step="any"
                            onInput={(e) => setValues(x.key, fromUnit(e.currentTarget.valueAsNumber))}
                          />
                          <span class="unit">{unitLabel()}</span>
                        </div>
                      </Match>
                      <Match when={true}>
                        <input type="number" value={values[x.key] as number} step="any" onInput={(e) => setValues(x.key, e.currentTarget.valueAsNumber)} />
                      </Match>
                    </Switch>
                  </label>
                )}
              </For>
              <div class="dialog-actions">
                <button class="btn" onClick={() => f.resolve(null)}>
                  {t("ws.cancel")}
                </button>
                <button class="btn primary" disabled={invalid()} onClick={ok}>
                  OK
                </button>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
