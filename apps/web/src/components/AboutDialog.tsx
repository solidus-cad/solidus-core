import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { contributions } from "../host.ts";
import type { I18nText } from "@solidus-cad/sdk";
import { t, tx } from "../i18n.ts";

const [open, setOpen] = createSignal(false);

export function openAboutDialog(): void {
  setOpen(true);
}

const L = (fr: string, en: string): I18nText => ({ fr, en });

interface Component {
  name: string;
  url: string;
  license: string;
  role: I18nText;
}

/** Source code of the open core (AGPL-3.0, section 13). */
const SOURCE_URL = "https://github.com/solidus-cad/solidus-core";

/** Open-source software bundled with the application (keep up to date with the shipped dependencies). */
const COMPONENTS: Component[] = [
  { name: "Open CASCADE Technology", url: "https://dev.opencascade.org", license: "LGPL-2.1 + exception", role: L("Noyau de modélisation B-rep", "B-rep modeling kernel") },
  { name: "PlaneGCS (FreeCAD)", url: "https://github.com/Salusoft89/planegcs", license: "LGPL-2.0-or-later", role: L("Solveur de contraintes d'esquisse", "Sketch constraint solver") },
  { name: "three.js", url: "https://threejs.org", license: "MIT", role: L("Rendu 3D", "3D rendering") },
  { name: "three-mesh-bvh", url: "https://github.com/gkjohnson/three-mesh-bvh", license: "MIT", role: L("Sélection rapide dans les maillages", "Fast mesh picking") },
  { name: "SolidJS", url: "https://www.solidjs.com", license: "MIT", role: L("Interface utilisateur", "User interface") },
  { name: "Mediabunny", url: "https://mediabunny.dev", license: "MPL-2.0", role: L("Export vidéo (Motion)", "Video export (Motion)") },
  { name: "fflate", url: "https://github.com/101arrowz/fflate", license: "MIT", role: L("Compression ZIP", "ZIP compression") },
  { name: "opentype.js", url: "https://github.com/opentypejs/opentype.js", license: "MIT", role: L("Lecture des polices (texte d'esquisse)", "Font parsing (sketch text)") },
  { name: "Liberation Sans", url: "https://pagure.io/liberation-fonts/", license: "GPL-2.0 + font exception", role: L("Police du texte d'esquisse", "Sketch text font") },
  { name: "JSON for Modern C++", url: "https://github.com/nlohmann/json", license: "MIT", role: L("Sérialisation du noyau", "Kernel serialization") },
  { name: "Emscripten", url: "https://emscripten.org", license: "MIT / UIUC", role: L("Compilation C++ → WebAssembly", "C++ → WebAssembly compiler") },
  { name: "Tauri", url: "https://tauri.app", license: "MIT / Apache-2.0", role: L("Application de bureau", "Desktop application") },
];

export function AboutDialog() {
  const close = () => setOpen(false);
  return (
    <Show when={open()}>
      <div class="dialog-backdrop" onClick={close}>
        <div
          class="dialog about-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("cmd.about")}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
          }}
        >
          <h2>{t("cmd.about")}</h2>
          <p>{t("about.text")}</p>
          <p>
            {t("about.source")}:{" "}
            <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
              {SOURCE_URL.replace("https://", "")}
            </a>
          </p>
          <For each={contributions("aboutItems")}>{(a) => <Dynamic component={a.component} />}</For>
          <h3>{t("about.oss")}</h3>
          <table class="about-oss">
            <tbody>
              <For each={COMPONENTS}>
                {(c) => (
                  <tr>
                    <td>
                      <a href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.name}
                      </a>
                      <div class="about-role">{tx(c.role)}</div>
                    </td>
                    <td class="about-license">{c.license}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <div class="dialog-actions">
            <button class="btn primary" onClick={close} ref={(el) => queueMicrotask(() => el.focus())}>
              OK
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
