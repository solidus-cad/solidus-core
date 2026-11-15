# Architecture

How Solidus is built and where things live. For features and how to build, see the [README](README.md).

## Principles
1. One C++ kernel, compiled to WebAssembly for the browser and natively for the desktop.
2. One TypeScript interface for both; only the transport to the kernel changes.
3. Heavy computation stays in the kernel. The interface displays, sends commands and never blocks.
4. Every workbench is a plugin, built on the same API as third-party plugins.

## Overview

```
┌───────────────────────────────────────────────────────────────────┐
│ Interface (TypeScript + SolidJS)                                  │
│  Ribbons · Tree · Property panels · i18n (15 languages)           │
│  Workbenches: sketch · part · sheet metal · assembly · tools      │
│  Sketch solver: PlaneGCS (WASM) · Assembly solver (TypeScript)    │
├───────────────────────────────────────────────────────────────────┤
│ Viewer (Three.js, WebGL2) · BVH picking · manipulators            │
├───────────────────────────────────────────────────────────────────┤
│ KernelClient (one TS interface)                                   │
│   ├─ Web     : Web Worker  ──postMessage──►  kernel.wasm          │
│   └─ Desktop : Tauri IPC ──stdin/stdout──►  cad-kernel process    │
├───────────────────────────────────────────────────────────────────┤
│ cad-core (C++20): feature tree, incremental recompute,            │
│ topological naming, parameters, sheet metal, HLR projections      │
├───────────────────────────────────────────────────────────────────┤
│ OpenCascade (OCCT 7.9): B-Rep, booleans, fillets, STEP, HLR       │
└───────────────────────────────────────────────────────────────────┘
```

## Stack
| Layer | Technology | Why |
|---|---|---|
| Geometry kernel | OCCT 7.9, only the modelling, data exchange and HLR modules | The only free industrial-grade B-Rep kernel (also used by FreeCAD and CadQuery) |
| Parametric engine | cad-core, C++20 | All geometry in one place, same code in WASM and native |
| Sketch solver | PlaneGCS (from FreeCAD, `@salusoft89/planegcs`) | Proven, compiles to WASM |
| Assembly solver | Our own, TypeScript, rigid bodies, Levenberg-Marquardt (`packages/assembly`) | The SolveSpace solver is GPL |
| Interface | TypeScript, SolidJS, Vite | Fine-grained reactivity, small bundle |
| 3D view | Three.js, `three-mesh-bvh` | Standard and fast picking |
| Desktop | Tauri 2 (Rust) | Much lighter than Electron |
| Tests | Catch2 (C++), Vitest, Playwright | |

Why not a Rust kernel: no B-Rep kernel written in Rust does reliable fillets and booleans yet. Rust is used where it
fits, in the Tauri backend.

On the desktop the native kernel runs as a separate `cad-kernel` process, driven over stdin / stdout
(`apps/desktop/src-tauri/src/kernel.rs`, `bindings/native/kernel_main.cpp`). It is faster than WASM, uses all threads
and is not limited to 4 GB of memory. The interface does not see the difference: only the `KernelClient` changes
(`packages/kernel-wasm/src/native.ts`).

## Repository layout

```
core/                 cad-core (C++): document, naming, part, mesh, analysis, io, tests
bindings/wasm/        Embind → kernel.wasm + kernel.js
bindings/native/      cad-kernel process of the desktop app
packages/sdk/         public API (MIT): kernel protocol, plugin API, types
packages/sketch/      sketch solver, profiles, 3D sketches
packages/viewer/      Three.js view, selection, manipulators
packages/kernel-wasm/ kernel clients (Worker, Node, native), document preparation
packages/assembly/    assembly solver, kinematics
benches/              part and sheet metal workbenches
modules/              open modules built into every build (gears, motion)
apps/web/             web application; apps/web/src/host.ts holds the extension points
apps/desktop/         Tauri app
examples/plugins/     example plugins
tools/                build scripts (OCCT, kernel, desktop)
ext/                  private modules of the official builds (not in this repository)
```

The core imports no private module. Modules are chosen at build time with `CAD_EXTENSIONS` and register through
`apps/web/src/host.ts` ([docs/MODULES.md](docs/MODULES.md)). Without them you get the open build: no account, no
licence, and the core makes no network calls (only a plugin granted a `network:` permission can reach the domain it
declared).

## Interface and kernel
- The interface sends `recompute` requests with the whole document as JSON. It is small: tree and parameters, never
  geometry. Requests that arrive while one is running are merged, so only the latest document is computed.
- The kernel answers with binary mesh buffers (positions, normals, indices, face and edge ids), transferred without a
  copy and loaded straight into a `BufferGeometry`.
- Each triangle carries the id of its B-Rep face. A pick in the view gives that id, and the kernel turns it into a
  stable topological name.
- The protocol is in `packages/sdk/src/kernel.ts`.

## Documents and recompute
- A part is an ordered list of features, with values or expressions as parameters and references to named entities.
  A part can hold several bodies; each feature acts on its target body.
- Recompute is incremental. Intermediate shapes are cached under a hash of the feature and everything before it, so
  only what changed is rebuilt and the rollback bar is instant.
- Undo keeps snapshots of the JSON document, never the geometry.
- Topological naming: each face and edge gets a name from its origin (for example the side face from segment 3 of the
  sketch of extrusion 2), using OCCT's history. That is what keeps a fillet alive when an upstream sketch changes.
  Details: [core/CONCEPTION.md](core/CONCEPTION.md) and [core/NAMING.md](core/NAMING.md).

### Files
`.vpart` (part) and `.vasm` (assembly) are zip archives with `document.json` (versioned), an optional `cache.brep`
for fast opening, and a thumbnail. Assemblies point to their parts by UUID and relative path
(`apps/web/src/docfiles/`); a missing part is flagged and can be replaced. The extensions may still change.

## Plugins
- A plugin is a `.vplug` zip with a `plugin.json` manifest (id, versions, permissions) and an ES module
  (`packages/sdk/src/plugin.ts`).
- Unverified plugins run in a Web Worker started from an isolated iframe, with no DOM access, and talk over message
  RPC (`apps/web/src/plugins/`). Their panels are declared as JSON forms.
- They can add commands, parametric features (`build(params, refs) → shape`, recomputed like any other feature),
  importers, exporters and panels.
- Permissions (`document.read`, `document.write`, `library`, `network:<domain>`) are approved by the user at install.

The core publishes events on a bus (`apps/web/src/events.ts`) without knowing who listens. The bug report
(`apps/web/src/bugreport/`) is a local subscriber that keeps a rolling log you can export.

## Licences
| Component | Licence | Note |
|---|---|---|
| This repository | AGPL-3.0-only + Solidus Plugin Exception | Sandboxed plugins may use any licence; contributions under [CLA.md](CLA.md) |
| SDK (`packages/sdk`) | MIT | |
| OCCT | LGPL-2.1 with the Open CASCADE exception | Statically linked; the build scripts and pinned sources let you rebuild it |
| PlaneGCS | LGPL-2.0 or later | Separate WebAssembly module |
| Mediabunny (Motion video export) | MPL-2.0 | Unmodified npm package |
| Three.js, SolidJS, fflate, opentype.js, Tauri | MIT / Apache-2.0 | A few Rust crates: MPL-2.0, Unicode, BSD, Zlib |
| Liberation Sans 1.07 (sketch text) | GPL-2.0 with font exception | Read at run time |

Full list: [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
