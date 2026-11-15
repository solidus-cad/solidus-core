# Solidus Roadmap

This is where we think Solidus should go next. There are no dates: the order matters more than the calendar, and plans
will move as we learn from users. If something here matters to you, or something is missing, open an issue.

## Where things stand

The open core already covers the basics of mechanical design:

- Part modelling: 2D and 3D sketches, extrude, revolve, sweep, loft, shell, draft, hole, fillet, chamfer, patterns,
  mirror, multi-body parts.
- Parameters and part families.
- Assemblies: mates, kinematics, liaison graph, interference checks, bill of materials.
- Sheet metal, section views, measurement and mass properties.
- Exchange: STEP, STL, OBJ, 3MF and DXF.

The open gears and Motion modules ship with every build. Separate modules add drawings, belts, surfaces, pipe and cable
routing, weldments, FEM, flow simulation, buckling, tolerance stacks, CAM, quoting and an AI assistant.

What keeps people from switching today is rarely a missing headline feature. It is the everyday things: a basic
operation that needs a workaround, a file from a customer that can't be edited, a drawing that has to follow US
standards. Most of phase 1 is about that.

## Phase 1: fill the gaps in the core

The goal is simple: a typical mechanical project should go from first sketch to finished drawing without leaving
Solidus.

### Part modelling

- Rib from an open sketch.
- Variable-radius fillets, face fillets, distance-angle chamfers.
- Driven patterns: along a curve, on sketch points, or from a table.
- Modelled and cosmetic threads, picked up by the drawing.
- Wrap and emboss text or a logo onto a curved face.
- Direct editing: push or pull a face, delete a face, move a hole, including on an imported STEP file with no history.

### Sketching

- Live patterns and mirrors inside a sketch.
- Reusable blocks, for layouts and 2D kinematic diagrams.
- DXF and DWG import into a sketch, with cleanup of duplicate and tiny segments.
- Better constraint diagnostics: say why a sketch is over-constrained, not just that it is.

### Assemblies

- Exploded views with steps and trail lines, reusable in drawings and in Motion.
- Component patterns, linear, circular or following a feature pattern, so the bolts on a flange take one click.
- In-context design: sketch a part against its neighbours, with external references that are easy to see and to break.
- Assembly configurations (variants, build states).
- Large assemblies: lightweight representations, partial loading, level of detail. We need to measure where things
  start to slow down today before setting targets.

### Drawings

- ANSI / ASME Y14.5: dimensions and tolerances in inches, first- or third-angle projection, US title blocks, building on
  inch units in the modeller.
- Detail views, broken views, broken-out sections.
- Assembly BOM linked to balloons, across several sheets.
- DWG export alongside DXF and PDF.

### Data exchange

- Read-only import of IGES, Parasolid (x_t) and JT, for files coming from customers and suppliers.
- Mesh to solid (STL, 3MF), for light reverse engineering.
- STEP AP242 export with PMI, as a first step towards drawing-less workflows.

### Reliability

- A rebuild report that says which feature failed, why, and which reference was lost, with suggested fixes.
- Crash recovery and visible autosave.
- A reference set of models replayed on every release, so that upgrading never breaks an existing model.

### Platforms

The installers only cover Windows and Linux on x64 for now. On an ARM machine you can use the browser version, and
Windows 11 on ARM runs the x64 installer under emulation. That works, but the geometric kernel does the heavy lifting
and it is noticeably slower that way.

- Linux on ARM64: a .deb and an AppImage, for ARM laptops and workstations, and boards like the Raspberry Pi 5 for
  lighter work.
- Windows on ARM64: a native installer for Snapdragon laptops, so the kernel no longer goes through emulation.
- macOS: Apple silicon first. The desktop app has not really been tested on a Mac yet, and it has to be signed and
  notarized by Apple before we can hand it out. Intel Macs will depend on demand.
- Each of these builds gets tested on real ARM hardware and replays the same reference models as the x64 builds
  before it ships.

## Phase 2: workflows for specific trades

The goal here is to reach the trades next to general mechanical design, mostly through modules built on the public SDK.

### Modules

| Module | For | What it does | Open or separate |
|---|---|---|---|
| Plastic parts | Injection-moulded part designers | Draft analysis, thickness map, bosses, snap fits, parting line, mould base basics | Separate module |
| Advanced sheet metal | Fabricators, laser cutting | Hems, jogs, louvres, corner reliefs, sheet metal from a solid, nesting of flat patterns | Hems in the core, nesting as a module |
| Fasteners | Everyone | Bolt wizard (screw, washer and nut sized to the hole), tightening torques, automatic BOM | Open, uses the parts library |
| Rendering | Sales, marketing | Photorealistic rendering, PBR materials, scenes, turntable videos | Free with an account, high-resolution renders paid |
| 3D printing | Makers, prototyping | Orientation, overhangs, minimum wall checks, export to slicers, simple lattices | Open |
| Reverse engineering | Maintenance, spare parts, existing designs | Scaled photos on any plane, assisted tracing, hand sketch to sketch, scan to parametric solid, deviation map | Photos on planes in the core, the rest as a module |
| Electrical / harness | Special machinery | Cable and harness routing, lengths, cut lists; builds on the pipe tool | Separate module |
| ECAD | Board integration | IDF / IDX import: board, components, keep-out areas; round trip with KiCad | Open |
| Moulds and tooling | Toolmakers | Core and cavity, shrinkage, ejector pins | Separate module, after Plastic parts |
| Topology optimisation | Design offices | Lightweighting from FEM load cases, result rebuilt as a solid | Separate module, after FEM |

### Reverse engineering

Start from a part that already exists, from a photo, a sketch or a scan, instead of redrawing it by eye.

- Photos on any plane: one or more images placed on a base plane, a reference plane or a planar face. Scale them
  from two points and a known distance, or automatically from an A4 sheet or a printed target placed next to the part.
  Perspective correction, adjustable opacity, and a lockable layer kept in the feature tree.
- Phone capture: Solidus runs in the browser, so the photo is taken without an app and lands on the chosen plane.
- Assisted tracing: edges detected on the photo become lines, arcs and splines, with inferred constraints (parallel,
  tangent, symmetric).
- Hand-drawn sketches: a photo of a dimensioned drawing on paper becomes a constrained sketch, through the AI module
  and the user's own API key.
- Scans and meshes: fit planes, cylinders, cones and spheres to a point cloud or an STL, rebuild a parametric solid,
  then show a deviation map between the scan and the model. This continues the mesh-to-solid work of phase 1.

### Assembly feasibility and assembly instructions

Check that an assembly can actually be put together, then explain how.

- Disassembly sequence: each part is pulled out, without collision, along a direction its mates leave free. Read
  backwards, the sequence is the assembly order.
- Parts that cannot be fitted are flagged, with the obstacle and the part that must go in first.
- Tool access: a virtual spanner, screwdriver or hex key checks that every screw can be tightened, including the
  room needed to turn it.
- Automatic instructions: illustrated steps in the style of flat-pack furniture, as exploded views and as a PDF,
  with the parts and fasteners of each step. They build on the exploded views of phase 1 and can be replayed in
  Motion.

### Synchronous modelling

Edit the geometry directly instead of replaying a fixed history, while keeping dimensions and design intent.

- Live rules during an edit: parallel, concentric, tangent, symmetric and coplanar faces found on the model stay that
  way. Each rule can be turned off case by case.
- Driving 3D dimensions placed on the solid: a dimension between two faces can be edited like a sketch dimension, even
  on an imported part.
- Feature recognition: holes, fillets, chamfers and patterns are detected on a dumb solid and become editable features
  again.
- Hybrid parts: a synchronous base body and an ordered history can live in the same part, and you can move between
  the two.
- Smart selection: one click selects all the faces of a boss, a pocket or a rib.

### Tablet mode

Solidus already runs in a browser, so a tablet needs no port. The interface does need work.

- Touch gestures in the viewport: one finger to orbit, two to pan, pinch to zoom, double tap to fit.
- A touch layout: larger targets, a contextual toolbar instead of the ribbon, radial menus on long press, a floating
  number pad for dimensions.
- Sketching with a stylus: freehand strokes recognised as lines, arcs and circles, constraints inferred, undo by
  gesture.
- First uses: design reviews, marking up drawings on the shop floor or at a customer's, measuring and sectioning,
  small edits. Full modelling comes later.
- Offline: open and mark up a project without a network, sync when back online.

### Core

- Design tables edited inside the application, not only in xlsx, driving configurations.
- Version history: compare two checkpoints (visual diff of the models), branches, merging parameters.
- Macros and scripting: record a sequence of actions and replay it; a script console on top of the plugin SDK.

## Phase 3: collaboration and ecosystem

From a tool for one person to a tool for a team, without locking anyone's data in.

- Shared review: a reader without a licence can review and mark up a part or a drawing, with comments attached to a
  face or a dimension, from a tablet too.
- A light project vault (PDM): states (in work, released, obsolete), revisions, check-out, a simple approval flow.
  It is not meant to be an ERP.
- A plugin marketplace: publishing, ratings, compatible versions, revenue shared with authors.
- A community library where users publish parts and profiles. This is in progress.
- ERP and quoting links: export BOMs, routings and costs to open formats (CSV, API) rather than to one specific ERP.
- Accessibility: full keyboard navigation, screen reader support in the panels, high-contrast themes.
