# Design of cad-core

Technical choices of the kernel and how it is integrated into the application. The code layout, the build and the tests are described in the [README](README.md), topological naming in [NAMING.md](NAMING.md).

## 1. What is prepared on the TypeScript side

The Worker of `@solidus-cad/kernel-wasm` prepares the document before sending it to the C++ side (`packages/kernel-wasm/src/prepare.ts`). The C++ side does not redo what TypeScript already does and what is shared with the interface. Everything goes through the `prepared` field of the feature (`FeatureInput::prepared`):

| Data | TS source | C++ function |
|---|---|---|
| expressions, parameters (family included) | `resolveParameters`, `evaluate` | all |
| solved sketch, loops, isolated points, segments, path start, polyline | PlaneGCS, `analyzeProfiles` | sketch, hole, slot, sweep, profile, sheetBase, sketchedBend |
| reference planes | `evalDatum`, `namedPlaneFrame` | plane, sketch, mirror |
| thickened outlines | `thinOutline` | thinExtrude |
| ISO dimensions, profile sections | `ISO_HOLES`, `sectionFamily` | hole, slot, profile |
| frame layout | `layoutFrame` | frameMembers |

- **Parameters and expressions**: for each feature, the kernel receives the raw expression, the value, or the error message. The C++ side only reports the error if the builder asks for the value (`ctx.num("width")` gives the message `width : Paramètre inconnu « L »`).
- **Sketches**: solved by PlaneGCS (`@solidus-cad/sketch`, `SketchSolver`), then analyzed (`analyzeProfiles`). The C++ side receives the solved geometry (points, curves), the oriented loops (regions, holes, chains) and the plane frame. Solving errors are sent separately (`« Cote : … »`, `« Le profil se recoupe »`): the kernel marks the feature in error without building it. Solutions are memoized as long as the sketch and the parameters do not change.
- **3D sketches**: solved by `solveSketch3D` (`@solidus-cad/sketch`, least squares) with the current parameters, then cut into chains (a chain stops at a point shared by more or fewer than two curves). Splines through points are interpolated on the TS side (`interpolate3`, same scheme as the plane splines) and sent as poles: the display and the kernel use the same curve. Everything goes in `prepared.curves3d`; `buildSketch3D` makes one wire per chain, used as sweep path, loft section or guide. A 3D sketch has no region: it is never a profile to extrude.

Why:
- a single evaluator and a single profile analysis, shared with the interface (preview, sketch diagnostics): no divergence between two implementations;
- on desktop, the client stays in TypeScript and applies the same preparation before sending the request to the kernel process.

Errors that the C++ side can detect itself are not prepared, so as to keep the messages and the order checked by the parity tests.

- **Splines**: a sketch spline (`SkBSpline`) is stored by its poles, which are points of the sketch, so the solver, the dimensions and dragging treat them like any point. Without explicit knots, they are uniform (`bsplineKnots`: clamped for an open spline, which then starts and ends at its first and last poles; periodic for a closed one). The client sends the knots and multiplicities, the kernel builds a `Geom_BSplineCurve` in the plane of the sketch. The spline tool draws through points: the poles come from an interpolation at the Greville abscissae (`interpolate`, `packages/sketch/src/bspline.ts`). A trim splits it exactly by knot insertion; the second piece is called `<id>.1`, so the faces it produces keep stable names.
  - **Constraints**: `pointOnCurve` uses the PlaneGCS `point_on_bspline` constraint, with a free parameter. Tangency is supported at an endpoint shared with a line, an arc or another spline: the end segment of the control polygon is aligned with the other curve.

If PlaneGCS is one day compiled into cad-core, `buildSketch` will be able to receive the raw sketch: only the `sketch` key of the input format (README) will change.

### Deferred preparation (body edges projected into a sketch)
A sketch can reuse an edge of the body computed upstream, while it is solved by PlaneGCS on the TypeScript side.

1. `prepare.ts` marks the sketch `deferred: { edges: [{ id, ref }] }`, without solving it.
2. When building it, the C++ engine resolves each `GeomRef` on the current body: name, then geometry (`Engine::complete`).
3. It calls back the client with the endpoints, the midpoint and the carrier circle of each edge (`Engine::Resolver`, a JS function passed to `Kernel.recompute` by Embind).
4. The client projects the edges into the plane, solves the sketch and returns the prepared sketch.

A `thinExtrude` on a deferred sketch is also deferred. When the C++ side reuses its cache, it does not call back the client: the last resolution remains valid (same inputs, same body), `SketchPreparer.lastDeferred`.

On desktop, the same callback goes through the kernel process protocol (§6).

Limitation: a deferred "skeleton" sketch, reused by another sketch, is only known at its last computation.

## 2. Cache
Each key is the hash (FNV-1a 64-bit) of the previous key and of the feature content; the first one is initialized with the global parameters. The feature identifier is part of the key, because topological names depend on it. Features in error are not cached. The engine keeps one cache per document (`docId`), freed by `forget`, and at most 8 documents (`trim`).

## 3. References (`Feature.refs`)
`resolveRefs` (`core/part/refs.cpp`) first resolves `GeomRef.name`, then the geometric signature:
- a memorized point within `max(sag × 4, 1e-3)`;
- then the closest size (length, area).

## 4. Protocol (`packages/sdk`)
- **`MeshPayload.names?: { faces: string[]; edges: string[] }`**: topological names indexed by mesh identifier, `faces[faceGroups[3k + 2]]`, `edges[edgeGroups[3k + 2]]`.
- **`GeomRef.name?: string`**: name of the designated element. The viewer reads it from `MeshPayload.names` at the time of selection (`packages/viewer/src/refpick.ts`). The application compares two selections by their name when they have one (`sameRef`, `apps/web/src/store.ts`).

Fields specific to `@solidus-cad/kernel-wasm` (`WasmRecomputeResult`): `topology` (same names as `MeshPayload.names`) and `timings` (`prepare`, `features`, `mesh`, `mass`, `names`, in ms).

### Error messages
Feature messages are checked by the parity tests (`packages/kernel-wasm/test/reference.json`). OCCT exceptions are presented in the form `message (Type)` and always attached to the feature at fault: an exception must never crash the Worker. A few cases get a readable message rather than the raw exception:
- **fillet or chamfer not possible**: "Le congé a échoué", "Le chanfrein a échoué" (instead of `StdFail_NotDone`);
- **revolve**: "Axe de révolution de longueur nulle" (instead of a `gp_Dir` exception).

## 5. Pruned OCCT
The OCCT CMake is not used: in OCCT 7.9, `TKDESTEP` depends on `TKXCAF`, which pulls in `TKV3d`, `TKService` (Visualization) and `TKCAF` (ApplicationFramework).

`tools/occt/CMakeLists.txt` compiles the useful toolkits from their `PACKAGES` and `FILES` files, and removes:
- the XCAF packages: `STEPCAFControl`, `IGESCAFControl`, `DESTL`;
- in `DESTEP` and `DEIGES`, everything except the `*_Parameters` files (the only ones used by `STEPControl` and `IGESControl`).

Consequence: no STEP import or export with colors, names and product structure (XCAF), therefore no STEP export of assemblies nor PMI. Adding them requires compiling `TKXCAF` without Visualization, which implies a patch to OCCT.

### OCCT pitfalls
- A compound of touching solids is not a valid argument of `BRepAlgoAPI_Fuse` (parts disappear or do not merge): fuse part by part.
- To test whether a point is inside a solid, do not rely on `BRepExtrema_DistShapeShape` (which does not always return 0): use the common volume with a small cube.
- Every native object created must be freed: RAII and `Handle` on the C++ side, `dispose()` for a `WasmKernelEngine` created on the TypeScript side. To check for leaks, recompute a heavy part 60 times (a pattern of 60 cuts) and track the WASM memory size: it must stabilize.

## 6. Integration into the application
`apps/web/src/kernel.ts` chooses the kernel:
- **browser**: cad-core WASM (`WasmKernelClient`);
- **desktop**: cad-core native (`NativeKernelClient`), falling back to WASM if it does not start.

`kernel.wasm` is a generated file, ignored by git: run `pnpm --filter @solidus-cad/kernel-wasm build:kernel` (or `tools/build-kernel.sh wasm`) before `pnpm dev` or `pnpm build`. The Worker imports `../dist/kernel.wasm?url` (Vite) and the PlaneGCS file.

### Native (desktop): a separate kernel process
`cad-kernel` (`bindings/native/kernel_main.cpp`) is declared as a Tauri *sidecar* (`bundle.externalBin`). `tools/build-kernel.sh native` copies it to `apps/desktop/src-tauri/binaries/cad-kernel-<triplet>`; `tauri build` requires it. Why a process rather than a direct link in Rust:
- no Cargo link with the OCCT static libraries (over 700 MB);
- a crash of OCCT does not take down the application, and the kernel is restarted;
- the deferred preparation callback becomes just one more exchange.

The protocol: frames `[u32 length][payload]` over stdin / stdout.
- **Requests** from the client: JSON.
- **Results** from the kernel: a JSON header, then binary arrays (mesh, exported files), without a JSON copy of the buffers.
- **Callback**: during a recomputation, the kernel sends `callback` (identifier, edges resolved on the current body). The client answers `reply` with the prepared sketch, and the kernel resumes.
- **OCCT output**: OCCT sometimes writes to stdout (STEP statistics); the protocol therefore goes through a copy of stdout, and stdout is redirected to stderr.

| Side | File | Role |
|---|---|---|
| Rust | `apps/desktop/src-tauri/src/kernel.rs` | starts `cad-kernel` on demand; one command, `kernel_exchange` (one frame in, the next one out, raw binary); restarts it after a stop |
| TS | `packages/kernel-wasm/src/native.ts` | `NativeKernelEngine` (TS preparation, callbacks, frame decoding; same `RecomputeResult` as WASM thanks to `assembleResult`), `NativeKernelClient`, `tauriExchange` |
| Application | `apps/web/src/kernel.ts` | desktop: native kernel, with fallback to WASM; browser: WASM |

`packages/kernel-wasm/test/native.test.ts` launches `cad-kernel` from Node, with the same frames as Tauri, and compares it to WASM.

On Windows, system headers define macros with short names (`far`, `near`, `min`, `max`...): do not use them as identifiers (`NOMINMAX` is defined).

## 7. Adding a feature
1. write `FeatureOutput buildXxx(const BuildContext&)`;
2. declare it in `core/part/features.hpp`;
3. register it in `registerPartFeatures` (`core/part/registry.cpp`);
4. add the file to `core/CMakeLists.txt`;
5. if it needs data from the client: prepare it in `prepare.ts` (`prepared`).

Available tools:
- `combine()`: add, cut, intersect or new body (`op` = `add`, `cut`, `intersect`, `new`), the tool is kept for symmetry and matrices;
- `ctx.bodies()`, `ctx.body(id)`, `ctx.targetId()`: bodies of the part, for a feature that reads several of them (§ 8);
- `booleanNamed()`: boolean of several named bodies;
- `resolveRefs()`: designated edges or faces;
- `TopoNames::derive()`: naming by OCCT history;
- `nameByRank()`: elementary parts.

## 8. Multi-body
A part is an **ordered list of bodies** (`DocState::bodies`, `core/document/engine.cpp`). A body carries the identifier of the feature that created it; a feature that creates several gives `<feature>`, `<feature>#2`... (see core/NAMING.md, "Multiple bodies").

- **Kind**: a body is **solid** or **surface** (`Body::kind`, `BodyKind`). Surface features (`core/part/surface.cpp`) always create a new surface body.
- **Target body**: `Feature.body`, otherwise the **active body** (the last **solid** body created or modified: a surface never becomes the default target). A target body that is not found is a feature error ("Corps introuvable"). An old document has no `body`: it only has one body, and its results are unchanged (`reference.json`).
- **Accepted target**: each feature is registered with `TargetKind::Solid` (default: volume operations) or `TargetKind::Any` (sketch, move, delete, surface features). A surface as the target of a volume operation is an explicit error ("Le corps cible est une surface : choisissez un corps solide"); on the interface side, `FeatureDefinition.bodyTarget` (`solid`, `any`, `none`) sets the proposed targets.
- **Consumed body** (`BodyChanges::consumed`): a body used by a feature and kept in the part (thickened surface, cutting body...) leaves the part as seen from outside and from export, and the interface hides it by default (`MeshBody.consumed`, `BodyDisplay.hidden` absent).
- **From surface to solid** (`core/part/solidify.cpp`): `thicken`, `closeSurface`, `cutWithSurface` and `replaceFace`. Their surfaces stay in the part, consumed.
  - Input surfaces are sewn first: a sketch extrusion is a compound of faces, not a shell.
  - `thicken` tries the offset with intersection (`BRepOffset_MakeOffset`, thickening mode), which keeps sharp corners; `BRepOffset_MakeSimpleOffset` takes over. A result is accepted if it is one valid solid with a volume of the order of area × thickness.
  - `cutWithSurface` decides the side of each piece on a face lying on the surface: the outward normal of the piece is opposed to the normal of the surface on the side the normal points to. Several pieces on the kept side each become a body.
  - `replaceFace`: the column of the face (prism ± L along its outward normal) is split by the surface. A piece touching both ends of the column proves the surface does not cover the face, which is an error. The piece under the surface, above the face, is added to the body; the piece over the surface, under the face, is removed from it. The neighbouring faces are therefore extended along the normal of the face, not along their own plane: a drafted neighbour leaves a wall (`wall(F).k`).
- **Builders**: `ctx.prev()` is the target body, so single-body features are unchanged. Their output:
  - a `Body` replaces the target body; with `Body::created` (`new` operation of `combine`), it becomes a new body;
  - a `BodyChanges` describes several effects: new shape of the target body, created bodies, removed bodies (consumed tools), removal of the target body itself.
- **Body features** (`core/part/bodies.cpp`): `combineBodies` (union, subtraction, intersection of the target body with the `tools` bodies, `keep` option), `deleteBody`, `moveBody` (translation, rotation, copy), `splitBody` (plane).
- **The part as seen from outside**: `Engine::partShape()` returns the single solid, or a compound of the non-consumed solids in creation order. Mass, drawing (`projectScene`), assembly (`exportPlaced`, `interferences`) and CAM (`camMesh`) go through it. Mass properties are the sum over the solids: an overlap between two bodies is counted twice. A part without a solid gives the area of its surfaces (zero volume); `mass.bodies` gives the area of each surface.
- **Export** (`exportShape`): non-consumed solids and surfaces; in STEP, surfaces are written as `shell_based_surface_model` (`STEPControl_AsIs`).
- **References**: `resolveRefs` looks in the target body for the default group (references without `group`). The interface attaches each selection to its body (`GeomRef.body`, from `MeshPayload.bodies`) and makes the feature target the body of its elements (`toggleRef`, `apps/web/src/store.ts`); the default group of a volume operation only designates solid elements. Multiple groups (`FeatureDefinition.refGroups`, `GeomRef.group`) are resolved by `resolveGroup`, across all bodies.
- **Protocol** (`RecomputeResult`):
  - `mesh.bodies`: ranges of face and edge identifiers of each displayed body (a single mesh, contiguous identifiers), with its kind (`kind`) and `consumed`;
  - `mesh.freeEdges`: identifiers of the free edges (edges of surfaces), underlined in the view and selectable with the `freeEdge` filter;
  - `mass.bodies`: mass of each body, when there are several;
  - `activeBody`, `partBodies`: active body and bodies of the part at the end of the recomputation;
  - `bodiesBefore` (on request, `RecomputeOptions.bodiesBefore`): bodies and active body just before a feature, i.e. those it can target while being edited in the middle of the tree.
- **Display**: `PartDocument.bodies` (name, color, visibility) does not affect the recomputation. A hidden body is removed from the mesh displayed by the interface (`hideBodies`, `packages/viewer/src/bodies.ts`), without changing the identifiers of the others.
- **Display of surfaces**: the view shows faces on both sides; the back side is tinted (orange), which gives the orientation of a surface; free edges are underlined (`freeEdgeLines`, `packages/viewer/src/bodies.ts`).
- **Downstream**: finite element analysis requires a single solid body and flags it (`ana.err.multiBody`, fem module), ignoring surfaces; the quote reads the total mass and the overall size.

## 9. Surfaces
The functions of the Surfaces module are native types built by cad-core (the module only declares their definitions). Each one creates a new surface body; the surfaces it transforms stay in the part, consumed. Names: core/NAMING.md.
- **Sweep and loft** (`core/part/loft.cpp`): `surfaceSweep` (`BRepOffsetAPI_MakePipeShell`, one sweep per wire of the profile, sharp corners of the path in `RightCorner` transition; orientation: corrected Frenet by default, Frenet, fixed, or constant binormal = normal of the path sketch, refused when it is tangent to the path). `surfaceLoft` and the solid `loft` of the Part workbench share their code: `ThruSections` without guide; with guides, a multi-section pipe along the first guide (the sections are placed where they are), the second one controlling the rotation. Paths, sections and guides may come from a 3D sketch (§ 1).
- **Planar surface and fill** (`core/part/fill.cpp`): planar faces of the regions of a sketch, or of a closed planar outline of picked edges; `fillSurface` (`BRepOffsetAPI_MakeFilling`, degree and segments bounded for WASM) with a continuity per edge (`GeomRef.choice`, G0 or G1). The support of a G1 edge is its single face for a surface edge, otherwise a face of the `supports` group. The patch deforms a mean plane of its boundary and cannot become perpendicular to it: the reached tangency (`G1Error`) is checked, a tangency out of reach is an error rather than a silent flat patch. The source bodies are copied first: OCCT adds pcurves to the edges it is given, the cached bodies must not change.
- **Editing** (`core/part/surfedit.cpp`): offset (offset with intersection, simple offset as a fallback), knit (sewing tolerance, solid option when closed), trim (by a body or a plane, side of the normal or the other, mutual trim knitting both kept parts: each surface must cross the other from edge to edge), extend (free edges of faces that are not trimmed, B-spline extended by length, natural or linear), extract faces. Faces are named after their origin face by proximity (`footOn`), independently of the algorithm. Shared tools: `core/part/surftools.hpp` (`cad::surf`).
- **Analyses** (`core/analysis/surface.cpp`): curvature at the nodes of the display triangulation, in the vertex order of `tessellate` (so one value per displayed vertex; signs follow the face orientation), and continuity along an edge between its two faces (G0 distance, G1 angle of the oriented normals, G2 gap of the normal curvatures across the edge). Requests `surfaceAnalysis` and `continuity` on the last recompute of a document. Zebra and draft are drawn by the view of the core (`Viewer.setShadingAnalysis`, a shader on the interpolated normals), without the kernel.
- **Memory**: no OCCT cache in a `static` (core/README.md, "Memory").

