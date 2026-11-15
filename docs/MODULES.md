# Modules: template for a module built with the application

A **module** is a separate repository (often private) that adds a workbench to Solidus without the open core knowing about it. The first extracted module is `cad-plugin-cam` (CAM); every private module (drawing, account…) follows the same template. There are two levels of extension:

| | First-party module (this document) | Third-party plugin (`definePlugin`) |
|---|---|---|
| Distribution | built with the application (`CAD_EXTENSIONS`) | `.vplug` package installed by the user |
| Execution | inside the application, access to internal modules (`@app/*`) | Worker sandbox or trusted mode, SDK API only |
| Usage | full workbenches (own document, ribbon, panels, 3D view) | parametric features, importers, simple panels |
| Rights | `ctx.license` (`LicenseProvider`) | same on the host side |

## 1. Structure of a module repository

```
cad-plugin-<name>/
  package.json        package name, dependencies (workspace), exports
  tsconfig.json       extends ../../tsconfig.base.json of the core, alias @app/* → ../../apps/web/src/*
  vitest.config.ts    unit tests of the engine
  playwright.config.ts  e2e: the application is served with CAD_EXTENSIONS
  src/engine/         engine without interface (testable under Node, usable by the server)
  src/ui/             SolidJS interface; imports the core via "@app/…" (never by relative path)
  src/extension.tsx   default export: an AppExtension that registers with the core
  test/  e2e/  examples/  docs/
  .github/workflows/ci.yml   clones the core, places the module in ext/<name>, typecheck + tests + build
```

The engine (`src/engine`) depends only on `@solidus-cad/sdk`, `@solidus-cad/assembly` and third-party libraries: the **private server** can import it (server-side validation of machines). The interface (`src/ui`) depends on the core.

## 2. Manifest and hookup

The module has no JSON manifest: its manifest is its `AppExtension` (`@solidus-cad/sdk`):

```tsx
export default defineExtension({
  id: "pro.solidus.cam",          // reverse-DNS notation
  activate(ctx) { /* … registrations … */ },
});
```

`activate` runs **before the first render**. The core's extension points are in `apps/web/src/host.ts` (reactive, order does not matter):

| Need | API |
|---|---|
| New document type (tabs, registration, file opening, history, dependencies) | `registerDocKind({ kind, icon, label, enter, leave, pack, doc, source, usesDoc, forget, save, openOrCreate, create, files, machine… })` |
| Ribbon tab | `tabRegistry.add({ … })` (`@app/plugins/tabs.ts`) |
| Left panel (replaces the tree while `when()` is true) | `contribute("leftPanels", { id, when, component })` |
| Banner above the assembly tree | `contribute("assemblyBanners", …)` |
| 3D toolbar button / 3D floating panel | `contribute("viewportTools" \| "viewportOverlays", …)` |
| Dialog window | `contribute("dialogs", { id, component })` |
| Footer of the central area (timeline), extra column to the right of the view, exclusive right panel | `contribute("centerFooters" | "stages" | "rightPanels", { id, when, component })` |
| CSS class of the workspace / of the central area | `contribute("classes", { id, target, name, when })` |
| Hook on the 3D view when it is created | `contribute("viewerBinders", { id, bind(viewer) })` |
| Workbench overlaid on the document (Calculation): opening/closing known to the core | `registerOverlay({ id, isOn, close })` |
| End of a context when returning to Assembly (motion study) | `registerContextCloser(fn)` |
| Part replaced by the result of a calculation | `registerBodyHider(() => boolean)` |
| Shortcut context provided by a module | `registerContextProvider(() => CONTEXTS key | undefined)` |
| Document linked to an open drawing (quote → original drawing) | `DocKindExtension.drawingId(id)` |
| Action offered to the core (catalog tile, menu command, ribbon button) | `registerModuleAction("catalog.machines", fn)` |
| Keyboard shortcuts | `registerActions([...])` (`@app/keymap/registry.ts`) |
| Menu command / bug report action | `ctx.ui.addMenuCommand`, `ctx.ui.addBugReportAction` |
| User settings, events | `ctx.settings`, `ctx.onEvent` |
| Document type saved to its own file, with references (`.vdrw`, `.vcam`) | `registerModuleDoc({ kind, filter, refs, write, read, remap })` (`@app/docfiles/documents.ts`) |
| Drop onto a document tab, "Create … from" entry, entry of the "+" menu | `DocKindExtension.acceptsDrop` / `drop`, `createFrom`, `create` + `newLabel` + `module` |
| View replacing the 3D view (drawing sheet) | `contribute("centerViews", { id, when, component })` |
| Editor over the 3D view that receives the viewer (welded frame) | `contribute("viewerEditors", { id, when, component })` |
| Tab of the right band (library, AI) | `contribute("rightTabs", { id, icon, label, legend, order, component })` |
| Tool of the Tools tab taking over the picking and the measurement panel (pipe / cable) | `toolRegistry.add(…)` + `registerMeasureTool(…)` (`@app/measure.ts`) |
| Keyboard of an editing mode (Enter / Escape of the welded frame) | `registerKeyMode({ id, active, key })` |
| Menu command at a given place (File › New drawing) | `insertMenuCommand(menu, after, command)` (`@app/commands.ts`) |
| Work awaited before the first render (local license, activation codes) | `registerStartup(fn)` |
| License of the official builds | `setLicenseBackend({ provider, … })` (`@app/license.ts`) |
| Additional themes and accents | `registerThemeProvider(…)` (`@app/theme.ts`) |
| Product name, read-only state | `setProductName`, `setReadOnlySource` (`@app/edition.ts`) |
| Menu of the menu bar, status bar indicator, banners, Appearance field, About paragraph | `contribute("menuBarMenus" \| "statusFlags" \| "appBanners" \| "firstRunBanners" \| "appearanceFields" \| "aboutItems", …)` |
| Workbenches of the module choice, workbenches hidden by an edition | `registerModules`, `hideModules` (`@app/plugins/modules.ts`) |
| Online plugin catalog | `registerPluginCatalog(…)` (`@app/plugins/settings.ts`) |
| Paid part workbench | `registerBenchFeature(benchId, feature)` (`@app/plugins/benches.ts`) |

The core contains no `import` of the module: it only uses these registries. Document type names (`"cam"`) are strings.

## 3. Rights (license)

A paid module **never** accesses the token or the license server. It requests its rights from `ctx.license` (`LicenseProvider` of `@solidus-cad/sdk`: `can`, `decide`, `require`, `onChange`), without knowing how the license is obtained. Refusal reasons: `no-license`, `expired`, `not-in-plan`, `seat-unavailable`. `openLicenseProvider` (everything granted) serves the open build and the tests, `closedLicenseProvider` the lock tests; the official builds plug theirs (signed licenses, account module) into the core with `setLicenseBackend` (`apps/web/src/license.ts`). Another host may provide its own implementation:

```ts
const withCam = (run: () => void) => ctx.license.require({ feature: "cam" }, run);
registerDocKind({ …, openOrCreate: () => withCam(openOrCreateCam), create: () => withCam(newCam) });
```

Rules: check at each **entry point** (creation, opening, tab), not only at display; react to `ctx.license.onChange` if a function must lock during a session; for an open build (`openLicenseProvider`) everything is granted — the real protection of a paid module is that it is **not distributed** to anyone who is not entitled to it (see §6).

## 4. Permissions

A first-party module has the rights of the application (like the core). It must make no network call without consent (the core "makes no network calls": `ARCHITECTURE.md`). Calls to the Solidus services go through the account module of the official builds, with the user's token. A third-party plugin, on the other hand, declares its permissions in `plugin.json` (`document.read`, `document.write`, `library`, `network:<domain>`) and runs in a sandbox unless it comes from a verified publisher.

## 5. Build, test, publication

```sh
git clone https://github.com/solidus-cad/solidus-core.git && git clone <module repository> cad/ext/<name>
cd cad && pnpm install
(cd ext/<name> && pnpm typecheck && pnpm test)                 # unit tests
CAD_EXTENSIONS=../../ext/<name>/src/extension.tsx pnpm dev     # development
CAD_EXTENSIONS=../../ext/<name>/src/extension.tsx pnpm build   # official build (several modules: comma-separated list)
(cd ext/<name> && pnpm test:e2e)
```

Mandatory validation at each change to the core: **the core alone** (`pnpm typecheck && pnpm test && pnpm build` without `ext/`) **and** the core with the module (the module's CI). The core must never depend on a module.

Official builds: their release pipeline (private) clones the shipped modules into `ext/`, runs their `build:assets` script if it exists, and derives `CAD_EXTENSIONS` from the list of modules.

Publication: there is no npm package for modules. Each module is a separate repository; its interface is only shipped in the builds that include it (`CAD_EXTENSIONS`). Modules declare the core packages with normal versions (`^0.1.0`): in the monorepo, `.npmrc` (`link-workspace-packages`) resolves them to the local sources.

## 6. Protecting a paid module

The core being public, a `hasFeature` test protects nothing: a fork removes it. Protection relies on:
1. the module's code is in a private repository, absent from the open build;
2. the official builds include it, or — planned evolution — the module is served (signed URL, like plugins) after a server-side rights check;
3. the license server issues the right (`features` of the token) and revokes it at expiry.

## 7. Reproducing with fem, quote

1. Create `cad-plugin-<name>` with the structure above.
2. Move the engine (`packages/<name>`) into `src/engine`, and the interface (`apps/web/src/<folder>`) into `src/ui` (script: rewrite `"../x"` as `"@app/x"`).
3. Replace each core call to this interface with a registry from `host.ts`; add an extension point if needed (sources of drawing views for quote, study banner for fem…).
4. Move the shared types and utilities out of the core (like `kinematics`/`archive`, moved to `@solidus-cad/assembly`).
5. Check: the core alone compiles and passes its tests; with the module, its tests and e2e tests pass.

Module **gears** (gears: straight or helical involute cylindrical wheels, racks, simplified bevel gears): `modules/gears`, open, part of the core and of every build (`BUILTIN` of `apps/web/vite-extensions.js`). It is also the reference example of a module. It relies on the core's `twistExtrude` function and on the assembly's coupling constraints, which stay in the core. It is free: there is no license function.

Module **motion** (motion studies on an assembly: tracks and keys on the mates, motors, collisions, video export with Mediabunny): `modules/motion`, open, part of every build (`BUILTIN`). Extracted first as a private module, it is now open. It asks `ctx.license` for the `motion` feature, which the core grants without a license module.

Module **surface** (surfaces serving solids: shells, housings, handles): `ext/surface`, repository `cad-plugin-surface`, license function `surface`. Its functions are not recipes (`pluginRecipe` only describes solids, without references to the model): they are native types, built by cad-core (`core/part/`), whose definitions the module declares. It therefore registers as a **part workbench** (`benchRegistry.add`): the core turns it into a tab of the Part ribbon, locked without rights (`needs`, view only), and its commands also go through `ctx.license.require` (the command palette runs them directly). Its declarative texts give all the interface languages (`I18nText` accepts languages other than `fr` and `en`). Its ribbon groups: Create (extrusion, revolution, sweep, loft, planar surface, fill), Edit (offset, knit, trim, extend, extract), To solid (thicken, close, cut, replace a face) and Analysis (zebra, draft, curvature, continuity: modes of the view, a binder and a floating panel; it depends on `@solidus-cad/viewer` for them). The solid loft is in the free Part workbench, with the same constructor.

Status: **cam, fem and quote are extracted** (`ext/<name>`, repositories `cad-plugin-<name>`); motion is open again (`modules/motion`). The core compiles, tests and builds without any of them.

## 8. Known limits
- The module's interface texts (`cam.*`, `mach.*`, `fix.*`) are still in `apps/web/src/i18n.ts` (typed). Planned: a `registerMessages` API.
- The gesture and shortcut action identifiers of the module (`cam.…`) are still in `gestures/gestures.ts` and `keymap/keymap.ts` of the core.
- There is no versioning of the internal `@app/*` API: a module is compiled with a precise version of the core (compatibility CI).
