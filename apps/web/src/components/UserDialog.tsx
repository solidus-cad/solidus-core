import { createSignal, For, onMount, Show } from "solid-js";
import { setLang, t, UI_LANGS, uiLang, type UiLang } from "../i18n.ts";
import { profileReady, setUserName, userName } from "../profile.ts";
import { runModuleAction } from "../host.ts";
import { draftingStandard, type DraftingStandard, inchFractions, lengthUnit, type LengthUnit, setDraftingStandard, setInchFractions, setLengthUnit } from "../units.ts";

/** "welcome": first launch (name required); "settings": edit from the Settings menu. */
const [mode, setMode] = createSignal<"welcome" | "settings" | null>(null);
const [value, setValue] = createSignal("");

export function openUserSettings(): void {
  setValue(userName());
  setMode("settings");
}

/** User name: asked once at first launch, editable in Settings › User. */
export function UserDialog() {
  // No prompt under an automated browser (end-to-end tests: storage cleared for each test).
  onMount(() => void profileReady.then(() => !userName() && !navigator.webdriver && setMode("welcome")));
  const close = () => mode() === "settings" && setMode(null);
  const submit = (e: Event) => {
    e.preventDefault();
    if (!value().trim()) return;
    void setUserName(value());
    if (mode() === "welcome") runModuleAction("roadmap.offer");
    setMode(null);
  };
  return (
    <Show when={mode()}>
      {(m) => (
        <div class="dialog-backdrop" onClick={close}>
          <form
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t(m() === "welcome" ? "user.welcome" : "user.title")}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
            }}
            onSubmit={submit}
          >
            <h2>{t(m() === "welcome" ? "user.welcome" : "user.title")}</h2>
            <p>{t("user.text")}</p>
            <label class="field">
              <span>{t("user.name")}</span>
              <input value={value()} onInput={(e) => setValue(e.currentTarget.value)} placeholder={t("user.placeholder")} autofocus autocomplete="name" />
            </label>
            <label class="field">
              <span>{t("user.language")}</span>
              <select value={uiLang()} onChange={(e) => setLang(e.currentTarget.value as UiLang)}>
                <For each={UI_LANGS}>{(l) => <option value={l.id}>{l.name}</option>}</For>
              </select>
            </label>
            <label class="field">
              <span>{t("units.length")}</span>
              <select value={lengthUnit()} onChange={(e) => setLengthUnit(e.currentTarget.value as LengthUnit)}>
                <option value="mm">{t("units.mm")}</option>
                <option value="in">{t("units.in")}</option>
              </select>
            </label>
            <Show when={lengthUnit() === "in"}>
              <label class="check">
                <input type="checkbox" checked={inchFractions()} onChange={(e) => setInchFractions(e.currentTarget.checked)} />
                <span>{t("units.fractions")}</span>
              </label>
            </Show>
            <label class="field">
              <span>{t("units.standard")}</span>
              <select value={draftingStandard()} onChange={(e) => setDraftingStandard(e.currentTarget.value as DraftingStandard)}>
                <option value="ISO">{t("units.std.iso")}</option>
                <option value="ASME">{t("units.std.asme")}</option>
              </select>
            </label>
            <div class="dialog-actions">
              <Show when={m() === "settings"}>
                <button type="button" class="btn" onClick={close}>
                  {t("prop.cancel")}
                </button>
              </Show>
              <button type="submit" class="btn primary" disabled={!value().trim()}>
                {t("prop.ok")}
              </button>
            </div>
          </form>
        </div>
      )}
    </Show>
  );
}
