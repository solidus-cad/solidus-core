import { createComponent } from "solid-js";
import { unwrap } from "solid-js/store";
import { networkAllowed, newId, type Feature, type FormField, type FormValues, type PluginContext, type PluginManifest, type PluginPermission } from "@solidus-cad/sdk";
import { lang, tx } from "../i18n.ts";
import { beginFeature, commit, setMessage, state } from "../store.ts";
import { activeKind } from "../workspace.ts";
import { commandRegistry, type AppCommand } from "../commands.ts";
import { DeclarativeRibbon } from "../components/DeclarativeRibbon.tsx";
import { openPluginForm } from "./PluginForm.tsx";
import { pluginTab } from "./builtin.tsx";
import { pluginFeatureTypes } from "./features.ts";
import { pluginTabId, setPluginTabId, tabRegistry } from "./tabs.ts";

/**
 * Plugin host: implementation of the `PluginContext` on the application side.
 * The same object serves both hosts: called directly by a trusted plugin, or by the RPC bridge
 * of a sandboxed plugin. Each contribution (command, tab) is removed on deactivation.
 */

export class PluginError extends Error {
  constructor(
    readonly pluginId: string,
    message: string,
  ) {
    super(`${pluginId} : ${message}`);
    this.name = "PluginError";
  }
}

/** Context of an active plugin, with the function that removes all its contributions. */
export interface HostApi {
  ctx: PluginContext;
  dispose(): void;
}

/** Order of the plugin tabs: after the built-in workbenches, in activation order. */
let nextOrder = 100;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(unwrap(v))) as T;

export function createHostApi(manifest: PluginManifest, report: (e: unknown) => void): HostApi {
  const id = manifest.id;
  const disposers: (() => void)[] = [];
  const commandIds = new Set<string>();
  /** Function types declared by the plugin (local identifiers). */
  const localTypes = new Set<string>();
  const fullId = (local: string) => `${id}/${local}`;

  const need = (p: PluginPermission) => {
    if (!manifest.permissions.includes(p)) throw new PluginError(id, `permission « ${p} » non déclarée`);
  };

  const storageKey = `cad.plugin.${id}`;
  const readStorage = (): Record<string, unknown> => {
    try {
      return (JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  };

  const ctx: PluginContext = {
    manifest,
    lang: async () => lang(),
    commands: {
      async register(c) {
        if (typeof c.run !== "function") throw new PluginError(id, `commande ${c.id} sans fonction run`);
        const cmd: AppCommand = {
          id: fullId(c.id),
          label: () => tx(c.label),
          icon: c.icon,
          run: () => {
            try {
              void Promise.resolve(c.run()).catch(report);
            } catch (e) {
              report(e);
            }
          },
        };
        commandIds.add(c.id);
        disposers.push(commandRegistry.add(cmd));
      },
    },
    tabs: {
      async register(tab) {
        for (const g of tab.groups) for (const c of g.commands) if (!commandIds.has(c)) throw new PluginError(id, `onglet ${tab.id} : commande inconnue ${c}`);
        const tabId = `plugin:${fullId(tab.id)}`;
        const groups = tab.groups.map((g) => ({ label: g.label, stacked: g.stacked, commands: g.commands.map((c) => ({ id: fullId(c) })) }));
        const remove = tabRegistry.add(
          pluginTab({ id: tabId, label: () => tx(tab.label), order: nextOrder++, docKinds: tab.docKinds?.length ? tab.docKinds : ["part"], body: () => createComponent(DeclarativeRibbon, { groups }) }),
        );
        disposers.push(() => {
          if (pluginTabId() === tabId) setPluginTabId(null);
          remove();
        });
      },
    },
    features: {
      async define(feat) {
        if (!/^[a-z][a-zA-Z0-9-]*$/.test(String(feat.type))) throw new PluginError(id, `type de fonction invalide : ${feat.type}`);
        if (typeof feat.build !== "function") throw new PluginError(id, `fonction ${feat.type} sans build`);
        for (const p of feat.params ?? [])
          if (!["length", "angle", "number", "enum"].includes(p.kind)) throw new PluginError(id, `paramètre ${p.key} : type ${p.kind} non pris en charge`);
        const type = fullId(feat.type);
        const build = feat.build;
        disposers.push(
          pluginFeatureTypes.add({
            id: type,
            pluginId: id,
            version: manifest.version,
            definition: { type, label: feat.label, icon: String(feat.icon ?? ""), params: clone(feat.params ?? []) },
            build: async (values) => build(values),
          }),
        );
        localTypes.add(feat.type);
      },
    },
    document: {
      kind: async () => activeKind(),
      async part() {
        need("document.read");
        return activeKind() === "part" ? clone(state.doc) : null;
      },
      async beginFeature(type) {
        need("document.write");
        beginFeature(localTypes.has(type) ? fullId(type) : type);
      },
      async addFeature(f) {
        need("document.write");
        if (activeKind() !== "part") throw new PluginError(id, "le document actif n'est pas une pièce");
        const feature = { ...clone(f), id: newId() } as Feature;
        commit((doc) => {
          doc.features.splice(doc.rollback, 0, feature);
          doc.rollback++;
        });
        return feature.id;
      },
    },
    ui: {
      notify: async (text) => setMessage(String(text)),
      form: (title: string, fields: FormField[]): Promise<FormValues | null> => openPluginForm(title, fields),
    },
    storage: {
      get: async <T,>(key: string) => readStorage()[key] as T | undefined,
      async set(key, value) {
        const all = readStorage();
        all[key] = JSON.parse(JSON.stringify(value ?? null));
        localStorage.setItem(storageKey, JSON.stringify(all));
      },
    },
    async fetch(url, init = {}) {
      if (!networkAllowed(manifest.permissions, url)) throw new PluginError(id, `accès réseau non autorisé : ${url}`);
      const res = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, credentials: "omit", redirect: "error" });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.status, headers, body: init.binary ? await res.arrayBuffer() : await res.text() };
    },
  };

  return {
    ctx,
    dispose() {
      for (const d of disposers.splice(0).reverse()) d();
      commandIds.clear();
      localTypes.clear();
    },
  };
}
