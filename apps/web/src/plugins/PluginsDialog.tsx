import { createEffect, createSignal, For, on, Show } from "solid-js";
import { lang, t, tx } from "../i18n.ts";
import { setMessage } from "../store.ts";
import { Dynamic } from "solid-js/web";
import { contributions } from "../host.ts";
import { activePlugins, deactivatePlugin, loadDevPackage } from "./manager.ts";
import { firstRunPending, hiddenNote, moduleEnabled, moduleShipped, MODULES, setModuleEnabled } from "./modules.ts";
import { tabRegistry } from "./tabs.ts";
import { applyFirstRun, catalogSource, installedPlugins, installPlugin, pluginCatalog, refreshCatalog, setPluginEnabled, uninstallPlugin, type PluginSummary } from "./settings.ts";

/** Plugin manager (File > Plugins): built-in modules, online catalog, active plugins, development loading. */

const [open, setOpen] = createSignal(false);
export const openPluginsDialog = () => setOpen(true);

/** Text per catalog language, falling back to French, then to the first language provided. */
const localized = (text: Record<string, string>): string => text[lang()] ?? text.fr ?? Object.values(text)[0] ?? "";

const errorText = (e: unknown) => (e instanceof Error && !("status" in e) ? e.message : (catalogSource()?.errorText(e) ?? String(e)));
const signedIn = () => !!catalogSource()?.signedIn();
const signIn = (then: () => void) => catalogSource()?.signIn(then);

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const MODULE_ICONS: Record<string, string> = {
  sheetmetal: svg('<path d="M3 17h8V9h10"/><path d="M3 17l2 3h8l-2-3M11 9l2-3h8l-2 3"/>'),
  drawing: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 16V9h5v7zM15 9h3M15 13h3"/>'),
  cam: svg('<path d="M12 3v8M9 11h6l-1 5h-4zM12 16v2"/><path d="M4 21h16M6 21l2-3M18 21l-2-3"/>'),
  motion: svg('<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.5 12h7M13 9l3 3-3 3"/>'),
  structures: svg('<path d="M3 20h18M5 20V8l7-4 7 4v12M5 8l14 12M19 8 5 20"/>'),
  fem: svg('<path d="M4 4h16v16H4zM4 12h16M12 4v16M4 4l8 8 8-8M4 20l8-8 8 8"/>'),
  quote: svg('<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v3h3M9 10h6M9 14h6M9 18h3"/>'),
  flow: svg('<path d="M3 8h9c3 0 3-3 0-3M3 12h14c3 0 3 4 0 4M3 16h7"/>'),
};

/** Workbench present in this build: shipped, and its ribbon tab registered (by the core or a compiled module). */
const moduleAvailable = (id: string): boolean => moduleShipped(id) && tabRegistry.list().some((tab) => tab.module === id || tab.id === id);

/** Choice of the built-in modules: toggle tiles (icon + name), on two lines; those absent from this build are "coming soon". */
function ModuleChoices(props: { value: (id: string) => boolean; onChange: (id: string, on: boolean) => void }) {
  return (
    <ul class="module-tiles">
      <For each={MODULES()}>
        {(m) => {
          const soon = () => !moduleAvailable(m.id);
          return (
            <li>
              <label class="module-tile" classList={{ on: !soon() && props.value(m.id), soon: soon() }} title={m.hint()}>
                <input type="checkbox" disabled={soon()} checked={!soon() && props.value(m.id)} onChange={(e) => props.onChange(m.id, e.currentTarget.checked)} aria-label={m.label()} />
                <span class="module-icon" innerHTML={MODULE_ICONS[m.id] ?? ""} />
                <strong>{m.label()}</strong>
                <small>{hiddenNote(m.id) ?? (soon() ? t("plg.soon") : m.hint())}</small>
              </label>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

/** Reloads the catalog when an account is signed in. */
function useCatalog() {
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const load = async () => {
    if (!signedIn()) return;
    setLoading(true);
    setError("");
    try {
      await refreshCatalog();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  return { error, loading, load };
}

export function PluginsDialog() {
  const [error, setError] = createSignal("");
  const [sandboxed, setSandboxed] = createSignal(true);
  const [busy, setBusy] = createSignal<string | null>(null);
  const cat = useCatalog();

  createEffect(on(open, (o) => o && void cat.load()));

  const run = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(`${id} : ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".vplug,.zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setError("");
      try {
        await loadDevPackage(new Uint8Array(await file.arrayBuffer()), !sandboxed());
      } catch (e) {
        setError(`${file.name} : ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    input.click();
  };

  const CatalogRow = (props: { p: PluginSummary }) => {
    const mine = () => installedPlugins()[props.p.id];
    return (
      <li>
        <div>
          <strong>{localized(props.p.name)}</strong> <small>{props.p.version}</small>
          <Show when={props.p.recommended}>
            <small class="plugin-badge">{t("plg.recommended")}</small>
          </Show>
          <small class="plugin-badge">{t("plg.by").replace("{a}", props.p.author)}</small>
          <Show when={localized(props.p.description)}>
            <p>{localized(props.p.description)}</p>
          </Show>
        </div>
        <div class="plugin-actions">
          <Show
            when={mine()}
            fallback={
              <button class="btn" disabled={busy() === props.p.id} onClick={() => void run(props.p.id, () => installPlugin(props.p.id))}>
                {busy() === props.p.id ? t("plg.busy") : t("plg.install")}
              </button>
            }
          >
            <label>
              <input type="checkbox" checked={mine()!.enabled} disabled={busy() === props.p.id} onChange={(e) => void run(props.p.id, () => setPluginEnabled(props.p.id, e.currentTarget.checked))} />
              {t("plg.active")}
            </label>
            <Show when={mine()!.version !== props.p.version}>
              <button class="btn" disabled={busy() === props.p.id} onClick={() => void run(props.p.id, () => installPlugin(props.p.id))}>
                {t("plg.update").replace("{v}", props.p.version)}
              </button>
            </Show>
            <button class="btn" disabled={busy() === props.p.id} onClick={() => void run(props.p.id, () => uninstallPlugin(props.p.id))}>
              {t("plg.uninstall")}
            </button>
          </Show>
        </div>
      </li>
    );
  };

  return (
    <Show when={open()}>
      <div class="dialog-backdrop" onClick={() => setOpen(false)}>
        <div
          class="dialog plugins-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("plg.title")}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <h2>{t("plg.title")}</h2>

          <h3>{t("plg.modules")}</h3>
          <p>{t("plg.modulesHint")}</p>
          <ModuleChoices value={moduleEnabled} onChange={setModuleEnabled} />

          <Show when={catalogSource()}>
            <h3>{t("plg.catalog")}</h3>
            <Show
              when={signedIn()}
              fallback={
                <button class="btn" onClick={() => signIn(() => void cat.load())}>
                  {t("plg.signIn")}
                </button>
              }
            >
              <Show when={pluginCatalog().length} fallback={<p>{cat.loading() ? "…" : t("plg.catalogEmpty")}</p>}>
                <ul class="plugins-list">
                  <For each={pluginCatalog()}>{(p) => <CatalogRow p={p} />}</For>
                </ul>
              </Show>
              <button class="btn" disabled={cat.loading()} onClick={() => void cat.load()}>
                {t("plg.refresh")}
              </button>
              <Show when={cat.error()}>
                <p class="field-error">{cat.error()}</p>
              </Show>
            </Show>
          </Show>

          <h3>{t("plg.title")}</h3>
          <Show when={activePlugins().length} fallback={<p>{t("plg.none")}</p>}>
            <ul class="plugins-list">
              <For each={activePlugins()}>
                {(p) => (
                  <li>
                    <div>
                      <strong>{tx(p.manifest.name)}</strong> <small>{p.manifest.version}</small>
                      <small class="plugin-badge">{p.trusted ? t("plg.trusted") : t("plg.sandbox")}</small>
                      <Show when={p.source === "dev"}>
                        <small class="plugin-badge">{t("plg.dev")}</small>
                      </Show>
                      <Show when={p.manifest.description}>
                        <p>{tx(p.manifest.description!)}</p>
                      </Show>
                    </div>
                    <button class="btn" onClick={() => void (p.source === "store" ? run(p.manifest.id, () => setPluginEnabled(p.manifest.id, false)) : deactivatePlugin(p.manifest.id))}>
                      {t("plg.unload")}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={error()}>
            <p class="field-error">{error()}</p>
          </Show>
          <label class="plugin-sandbox-opt">
            <input type="checkbox" checked={sandboxed()} onChange={(e) => setSandboxed(e.currentTarget.checked)} />
            <span>{t("plg.sandboxOpt")}</span>
          </label>
          <div class="dialog-actions">
            <button class="btn" onClick={pick}>
              {t("plg.loadDev")}
            </button>
            <button class="btn primary" onClick={() => setOpen(false)}>
              {t("plg.close")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

/**
 * First-startup wizard: choice of the modules and of the recommended catalog plugins.
 * Not displayed under automation (end-to-end tests) unless explicitly requested (`cad.plugins.prompt`).
 */
export function FirstRunDialog() {
  const automated = (() => {
    try {
      return navigator.webdriver && localStorage.getItem("cad.plugins.prompt") !== "1";
    } catch {
      return navigator.webdriver;
    }
  })();
  const [modules, setModules] = createSignal<Record<string, boolean>>({});
  const [picked, setPicked] = createSignal<Record<string, boolean>>({});
  const [busy, setBusy] = createSignal(false);
  const cat = useCatalog();

  createEffect(on(() => firstRunPending() && !automated, (show) => show && void cat.load().then(() => setPicked(Object.fromEntries(pluginCatalog().filter((p) => p.recommended).map((p) => [p.id, true]))))));

  const submit = async () => {
    setBusy(true);
    const failed = await applyFirstRun({ modules: modules(), plugins: Object.keys(picked()).filter((id) => picked()[id]) });
    setBusy(false);
    if (failed.length) setMessage(failed.join(" ; "));
  };

  return (
    <Show when={firstRunPending() && !automated}>
      <div class="dialog-backdrop">
        <div class="dialog plugins-dialog" role="dialog" aria-modal="true" aria-label={t("plg.firstTitle")}>
          <h2>{t("plg.firstTitle")}</h2>
          <For each={contributions("firstRunBanners")}>{(b) => <Dynamic component={b.component} />}</For>
          <p>{t("plg.firstIntro")}</p>
          <h3>{t("plg.modules")}</h3>
          <ModuleChoices value={(id) => modules()[id] !== false} onChange={(id, on) => setModules((m) => ({ ...m, [id]: on }))} />
          <Show when={catalogSource()}>
            <h3>{t("plg.catalog")}</h3>
            <Show
              when={signedIn()}
              fallback={
                <button class="btn" onClick={() => signIn(() => void cat.load())}>
                  {t("plg.signIn")}
                </button>
              }
            >
              <Show when={pluginCatalog().length} fallback={<p>{cat.loading() ? "…" : t("plg.catalogEmpty")}</p>}>
                <ul class="plugins-list">
                  <For each={pluginCatalog()}>
                    {(p) => (
                      <li>
                        <label>
                          <input type="checkbox" checked={picked()[p.id] === true} onChange={(e) => setPicked((s) => ({ ...s, [p.id]: e.currentTarget.checked }))} />
                          <strong>{localized(p.name)}</strong> <small>{p.version}</small>
                          <p>{localized(p.description)}</p>
                        </label>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={cat.error()}>
                <p class="field-error">{cat.error()}</p>
              </Show>
            </Show>
          </Show>
          <div class="dialog-actions">
            <button class="btn primary" disabled={busy()} onClick={() => void submit()}>
              {busy() ? t("plg.busy") : t("plg.firstOk")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
