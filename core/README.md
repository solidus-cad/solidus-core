# cad-core

C++20 CAD kernel built on a pruned OCCT 7.9.3, behind the `KernelClient` interface of `@solidus-cad/sdk`.
- **Web**: compiled to WebAssembly (Emscripten), used by `@solidus-cad/kernel-wasm` in a Web Worker.
- **Desktop**: compiled natively, launched by Tauri as a separate process (`cad-kernel`).

Related documents:
- [CONCEPTION.md](CONCEPTION.md): technical choices, protocol, integration into the application.
- [NAMING.md](NAMING.md): topological naming.

## Layout

| Folder | Contents |
|---|---|
| `document/` | recomputation engine: per-document cache, chained keys, deferred preparation |
| `part/` | feature builders (extensible registry: `registerPartFeatures`) |
| `naming/` | topological naming (`TopoNames`) |
| `mesh/` | BRepMesh meshing, `MeshPayload` layout |
| `analysis/` | mass properties, inertia, HLR projection and sections |
| `io/` | STEP and STL export |
| `tests/` | Catch2 tests |
| `../bindings/wasm/` | Embind bindings: `kernel.js` + `kernel.wasm` |

## Build
Prerequisites: CMake, Ninja, Git Bash on Windows. `tools/env.sh` installs emsdk and downloads OCCT, nlohmann/json and Catch2 into `third_party/` if needed.

```sh
tools/build-occt.sh wasm      # pruned OCCT as static libraries (once, long)
tools/build-kernel.sh wasm    # cad-core + C++ tests + packages/kernel-wasm/dist/kernel.{js,wasm}
pnpm --filter @solidus-cad/kernel-wasm test   # kernel tests, including parity with the reference results
```

Variables:
- `JOBS`: parallel compilations (default: half the cores);
- `KEEP_GOING=1`: all errors in a single build.

Targets:
- `wasm`: default target;
- `wasm-mt`: pthreads;
- `native`: MSVC on Windows (Visual Studio Build Tools 2022), system compiler on Linux and macOS (untested).

> On a laptop with weak cooling, a long build may trigger a thermal shutdown. Disable Turbo Boost during the build (`powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 99`, then `powercfg /setactive SCHEME_CURRENT`) and keep `JOBS` low.

Durations measured on an i7-6820HQ (4 cores), Turbo disabled, `JOBS=2`:
- incremental build of cad-core: 5 to 8 min, mostly spent linking (`wasm-ld`, then `wasm-opt -O3`);
- full native OCCT build (MSVC, 4,493 files): 1 h 45, 715 MB of static libraries;
- native cad-core: under one minute.

## Module size

| | raw | gzip -9 | brotli -q 11 |
|---|---|---|---|
| `kernel.wasm` | 20.0 MiB (21.0 MB) | 6.2 MiB | 4.3 MiB |

History: 18.9 MiB (5.9 MiB gzip) before the Surfaces workshop; multi-body, surfaces, sweep and loft, fill, surface
editing and analyses (2026-11) added 1.1 MiB raw, 0.3 MiB gzip. `packages/kernel-wasm/test/size.test.ts` enforces a
budget (22 MiB raw, 7 MiB gzip): raise it on purpose, and update this table.

The module contains STEP reading and writing, STL writing, HLR (drawings) and topological naming. Its size comes from the pruning of OCCT: no Visualization, no Application Framework, no XCAF (see [CONCEPTION.md](CONCEPTION.md), "Pruned OCCT"). The JS bootstrap code weighs 105 KiB.

## Performance
**Native and WASM**: same C++ tests (`cadcore_tests`: boxes, fillets, export, naming), same machine (i7-6820HQ, Turbo active):

| | native (MSVC, x64) | WASM (Node 24) |
|---|---:|---:|
| Total test time | 1.26 s | 5.90 s (×4.7, including the WASM warm-up) |
| "names stay stable when dimensions change" | 0.32 s | 0.64 s (×2) |
| "applies fillets and chamfers" | 0.18 s | 0.51 s (×2.8) |

The native build (desktop application) is therefore **2 to 3 times faster** than WASM once the latter is optimized by the JS engine, and even more on short computations or at startup.

At each recomputation, cad-core does the following in addition to geometry:
- topological naming (history of each operation, edge names for meshing);
- TS preparation (PlaneGCS, profile analysis);
- JSON serialization of the document.

Speed levers not used yet: multithreading (`wasm-mt`, parallel meshing and booleans) and incremental meshing (re-mesh only the modified faces, which stable names make possible). `WasmRecomputeResult.timings` (`prepare`, `features`, `mesh`, `mass`, `names`) helps to target the work.

## Memory

The cache keeps, for each open document, only the result of its last recompute: the shapes of the previous states are
freed. `pnpm --filter @solidus-cad/kernel-wasm test:memory` (about 3 minutes, outside of `test`) recomputes a heavy
surface part 60 times with a changing dimension, its curvature analysed each time, and checks that the memory allocated
by the kernel (`Kernel.memory()`: malloc, WASM heap) no longer grows after a warm-up: 0.5 MiB allocated, heap 32 MiB
(its initial size) on 2026-11-03. Never keep an OCCT cache in a `static` (an `IntTools_Context` shared across calls
leaked 15 MiB over the same 60 recomputes, every face ever classified staying in it).

Surface features in WASM (same check): offset of a three-section loft ≈ 1.7 s, thicken ≈ 0.25 s, G1 fill of a circular
opening ≈ 0.1 s, mesh and mass of the part ≈ 0.3 s.

## Tests
- **C++** (`tests/`, run by `tools/build-kernel.sh`): engine (cache, errors, references, shell, export, registry) and naming (box, cylinder, fillet, union, cut, extrusion).
- **TS parity** (`packages/kernel-wasm/test/`): each document is recomputed by cad-core and compared with recorded reference results (`reference.ts`, `reference.json`). Statuses, messages, volumes, areas, centers, inertia, face counts, solved sketches, flat patterns, views and interferences are compared.
  - `parity.test.ts`: all scenarios of `scenarios.ts` (one feature or one error case each), STEP import, inertia, `meshBefore`, `featureAt`;
  - `requests.test.ts`: sheet metal and flat pattern, interferences, drawings, sections;
  - `projected.test.ts`: linked elements in sketches;
  - `naming.test.ts`: name stability when dimensions change;
  - `engine.test.ts`, `recipe.test.ts`, `sheetmetal.test.ts`: features, plugin recipes, sheet metal.

  `reference.json` can no longer be re-recorded: to add a parity scenario, an expected value must be established another way (hand calculation, other software).
- **Native** (`native.test.ts`): launches the `cad-kernel` executable and compares its results with those of WASM.
