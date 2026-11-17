import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t, type TKey } from "../i18n.ts";
import { ACCENTS, accent, accentLocked, setAccent, setThemeChoice, SKINS, skinLocked, skinOffered, theme, themeChoice, themeProvider, type Accent, type ThemeChoice } from "../theme.ts";
import { contributions } from "../host.ts";
import { explainLocked } from "../license.ts";

const [open, setOpen] = createSignal(false);

/** Theme picker choices: light and dark, then the themes offered by the theme module, if any. */
const choices = (): ThemeChoice[] => ["light", "dark", ...SKINS().map((k) => k.id).filter(skinOffered)];
const extra = (c: ThemeChoice): boolean => c !== "light" && c !== "dark";
const skinOf = (c: ThemeChoice) => SKINS().find((k) => k.id === c);
/** Locked theme or accent: the dialog closes and the license module offers Premium (nothing without it). */
const offerPremium = () => {
  setOpen(false);
  void explainLocked("premium");
};
const choiceLabel = (c: ThemeChoice): string => (extra(c) ? (skinOf(c)?.label() ?? c) : t(`theme.${c}` as TKey));
const accentLabel = (a: Accent): string => a.label?.() ?? t(`accent.${a.id}` as TKey);

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export const openAppearance = () => setOpen(true);

/** Settings › Appearance: theme (light, dark, module themes), accent colour and the fields of the modules (activation code). */
export function AppearanceDialog() {
  const close = () => setOpen(false);
  return (
    <Show when={open()}>
      <div class="dialog-backdrop" onClick={close}>
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("appearance.title")}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
          }}
        >
          <h2>{t("appearance.title")}</h2>
          <div class="field">
            <span>{t("appearance.theme")}</span>
            <div class="theme-choices" role="radiogroup" aria-label={t("appearance.theme")}>
              <For each={choices()}>
                {(c) => {
                  const locked = () => extra(c) && skinLocked(c);
                  return (
                    <button
                      type="button"
                      role="radio"
                      class={`theme-choice preview-${c}`}
                      classList={{ active: themeChoice() === c }}
                      aria-checked={themeChoice() === c}
                      aria-disabled={locked() ? "true" : undefined}
                      title={locked() ? skinOf(c)?.lockHint?.() : undefined}
                      onClick={() => (locked() ? offerPremium() : setThemeChoice(c))}
                    >
                      <span class="theme-sample" />
                      {choiceLabel(c)}
                      <Show when={locked()}>
                        <span class="lock" innerHTML={LOCK_ICON} />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
          <div class="field">
            <span>{t("appearance.accent")}</span>
            <div class="accent-swatches">
              <For each={ACCENTS()}>
                {(a) => (
                  <button
                    type="button"
                    class="accent-swatch"
                    classList={{ active: accent() === a.id && !accentLocked(a.id), locked: accentLocked(a.id) }}
                    style={{ background: theme() === "dark" ? a.dark : a.light }}
                    title={accentLabel(a) + (accentLocked(a.id) ? ` — ${themeProvider()?.accentLockHint?.() ?? ""}` : "")}
                    aria-label={accentLabel(a)}
                    aria-pressed={accent() === a.id}
                    aria-disabled={accentLocked(a.id) ? "true" : undefined}
                    onClick={() => (accentLocked(a.id) ? offerPremium() : setAccent(a.id))}
                  >
                    <Show when={accentLocked(a.id)}>
                      <span class="lock" innerHTML={LOCK_ICON} />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
          <For each={contributions("appearanceFields")}>{(f) => <Dynamic component={f.component} />}</For>
          <div class="dialog-actions">
            <button type="button" class="btn primary" onClick={close} autofocus>
              {t("prop.ok")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
