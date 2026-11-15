# Topological naming in cad-core

## The problem
A feature such as "fillet on edge X" must find X again after a recomputation. But OCCT guarantees nothing about the order of sub-shapes: after an upstream change (a dimension, a sketch), the "7th edge" is no longer the same one.

This is the number one cause of broken trees in parametric CAD. Every face and every edge therefore gets a **stable name, derived from its origin**, and never from its rank.

## Principle
1. **Faces carry the information.** Each face gets a name when it is created, and this name follows OCCT's history (`BRepTools_History`: `Modified`, `Generated`, `IsRemoved`) at every operation.
2. **Edges and vertices are named by the faces they separate.** An edge is the intersection of two faces: `e(A|B)`. A vertex is the intersection of three or more faces: `v(A|B|C)`.

   This choice is more robust than following the history of the edges themselves, which are split and merged again at every boolean (for example by `ShapeUpgrade_UnifySameDomain`). It remains exact as long as the faces are named correctly.
3. **The name only depends on the tree**: feature identifiers, sketch curve identifiers and face roles. It never depends on dimensions. The names therefore stay identical when a dimension changes (see the tests).

## Grammar

```
face     := feature "/" role [ "#" k ]
role     := primitive | "side(" curve ")" | "start(" region ")" | "end(" region ")"
          | "fillet(" origin ")" | "chamfer(" origin ")" | "shell(" origin ")" | "gen(" origin ")"
          | "thin(" chain "." rank ")"
          | "side(" curve "|" section ")" | "start" | "end"             (sweep, profile, surface sweep)
          | "side(" curve [ "." span ] ")" | "start" | "end"            (loft: curve of the first section)
          | "plane(" region ")" | "plane" | "fill"                      (planar surface, fill)
          | "offset(" face ")" | "knit(" face ")" | "trim(" face ")"   (offset, knit, trim)
          | "extend(" face ")" | "copy(" face ")" | "face(" face ")"   (extend, extract faces)
          | "hole(" point "." segment ")" | "slot(" line "." piece ")"  (hole, slot)
          | "copy" k "(" face ")"                                       (mirror, matrices)
          | "copy(" face ")"                                            (copy of a moved body)
          | "plane"                                                     (split plane of a body)
          | "member(" skeleton-line "." rank ")"                         (welded frame)
          | "top(" region ")" | "bottom(" region ")"                     (flat sheet)
          | "plate(" i ")." rank | "bend(" i ")." rank                   (sheet along a profile)
          | "bend(" edge ")." rank | "flange(" edge ")." rank | "relief(" origin ")"  (flange)
          | "face(" rank ")"                                            (STEP import)
primitive:= "top" | "bottom" | "front" | "back" | "left" | "right" | "lateral"
origin   := edge | vertex | face
edge     := "e(" face { "|" face } ")" [ "#" k ]
          | "e(" face "|~)" [ "#" k ]                                   (free edge: edge of a surface)
vertex   := "v(" face { "|" face } ")" [ "#" k ]
```

- `feature`: identifier of the feature in the document (`Feature.id`, a UUID).
- `curve`: identifier of the sketch curve (`SkGeometry.id`).
- `region`: the smallest curve identifier of the outer contour of the region.
- Faces in a list `e(…)` or `v(…)` are sorted and deduplicated. The seam of a cylinder touches only one face: `e(f1/lateral)`.
- **Free edge** (edge of a surface: a single face, without being its seam): `e(F|~)`. The `~` sorts after face names. A closed solid has none, so solid names are unchanged.
- **Virtual end face**: a feature can explicitly name a free edge with a face that does not exist, `e(sx/side(l1)|sx/start)` (`TopoNames::setEdge`). This name replaces `e(F|~)` as long as the edge stays free, and follows the history (`Modified`) in `TopoNames::derive`; an edge that has become shared by two faces (thickened surface, sewn) takes a name by its faces again.
- Primitives: `front` is the min-Y face (the front view looks from −Y), `back` is max Y, `left` is min X, `right` is max X. These are not OCCT's names (`FrontFace` = max X).
- `section`: curve of the section sketch; `outer` / `inner` for a circular tube; `e<k>` for a profile section (rank of the edge in the catalog section, whose topology depends only on the size).
- `segment`: rank of the segment in the half-profile of the hole (0: top); `piece`: `a<k>` and `b<k>` for the ends of a slot, `s<k>` for its straight part.
- `span`: loft face split between sections (ruled loft: one face per pair of successive sections), from 0. A curve of the
  first section that gives a single face has no `span`. Faces that the history links to no curve (unexpected) are
  named `side(#k)` by rank.
- **Rim of a planar or fill surface**: its edge along a designated edge E is named through the virtual face
  `<id>/rim(E)`, E being the topological name of the reference (`rim(<k>)`, its rank, if the reference has none);
  along the curve C of a sketch region: `<id>/rim(C)`.
- **Edited surfaces**: offset, knit, trim, extend and extract faces create a new body, every face of which is named
  after its origin face F (the closest face of the input, independent of the algorithm). Cut edge of a trim, along the
  tool face T: `e(<id>/cut(T)|<id>/trim(F))`, T being `plane` for a plane tool.
- Path and guide curves may come from a 3D sketch (`Sk3Line`, `Sk3Spline`): `curve` is then their identifier in the 3D
  sketch, as for a plane sketch.
- `rank`: only for elementary parts whose topology does not depend on dimensions (bend sector, plate, slot end) or without a known origin (imported file).

Examples taken from the tests:

| Entity | Name |
|---|---|
| Top face of a box | `f0/top` |
| Wall of a cylindrical hole | `f1/lateral` |
| Edge between the front face and the top | `e(f0/front\|f0/top)` |
| Edge of the hole on the top face | `e(f0/top\|f1/lateral)` |
| Fillet face from this edge | `f2/fillet(e(f0/front\|f0/top))` |
| Corner fillet face (vertex) | `f2/fillet(v(f0/front\|f0/right\|f0/top))` |
| Side face of an extrusion from segment `l2` | `ex/side(l2)` |
| Side face of an extrusion from spline `s3`, then from the second piece of `s3` after a trim | `ex/side(s3)`, `ex/side(s3.1)` |
| Inner face of a shell, offset from the bottom of the block | `sh/shell(f0/bottom)` |
| Thin extrusion of the chain `l1`-`l2`: 3rd element of the thickened outline, then start face | `th/thin(l1.2)`, `th/start(l1)` |
| Top of the extrusion of region `l1` | `ex/end(l1)` |
| Top face split in two by a groove | `f0/top#1`, `f0/top#2` |
| Wall of a tube swept along arc `arc` of the path | `sw/side(arc\|outer)` |
| Counterbore of the hole placed at point `p0` (2nd segment of the profile) | `h/hole(p0.2)` |
| Bend of a flange on the top edge of the sheet | `fl/bend(e(base/side(l3)\|base/top(l1))).3` |
| Copy no. 2 of a pocket by a pattern | `mx/copy2(pk/bottom)` |
| Face of a surface extrusion from curve `l1` | `sx/side(l1)` |
| Start edge and end edge of this face (virtual end faces, sorted names) | `e(sx/side(l1)\|sx/start)`, `e(sx/end\|sx/side(l1))` |
| Free side edge (end of the open chain) | `e(sx/side(l1)\|~)` |
| Surface swept by segment `s1` of the profile along the 3D spline `sp` | `sw/side(sp\|s1)` |
| Side face of a loft from edge `q1` of the first section, then its 2nd span (ruled loft) | `lf/side(q1)`, `lf/side(q1.1)` |
| End faces of a solid loft; start edge of a surface loft | `lf/start`, `lf/end`; `e(lf/side(q1)\|lf/start)` |
| Fill of the top opening of the tube `tb`, and its edge along it | `ft/fill`, `e(ft/fill\|ft/rim(e(tb/end\|tb/side(c1))))` |
| Planar surface of region `l1` of a sketch, its edge along curve `l3` | `ps/plane(l1)`, `e(ps/plane(l1)\|ps/rim(l3))` |
| Plate trimmed by a plane, and its cut edge | `tr/trim(ps/plane(l1))`, `e(tr/cut(plane)\|tr/trim(ps/plane(l1)))` |
| Face of a box extracted, then knitted with five others into a solid | `x1/face(bx/top)`, `kn/knit(x1/face(bx/top))` |
| Top of a box copied by "Déplacer un corps" | `mv/copy(f0/top)` |
| Cut faces of a body split by a plane (one per piece) | `sp/plane#1`, `sp/plane#2` |
| Skins of a thickened surface: the surface itself, then its offset | `th/base(sx/side(l1))`, `th/thick(sx/side(l1))` |
| Wall of a thickened surface, facing a free edge | `th/wall(e(sx/side(l1)\|sx/start))` |
| Face of a solid closed from surfaces | `cl/closed(sx/side(l1))` |
| Face left by a cut with a surface | `cs/cut(sx/side(l1))` |
| Face replacing the top of a box, then its second piece if the two sides of a crossing surface do not merge | `rp/replace(f0/top)`, `rp/replace(f0/top)#2` |
| Side wall added by a face replacement (not merged with a neighbour) | `rp/wall(f0/top).1` |

## Propagation rules (`TopoNames::derive`, naming/naming.cpp)
After each operation, each face of the result is named as follows:

1. **Kept or modified face** (`Modified` empty and face still present, or face in `Modified(f)`): it keeps the name of the original face, and its aliases.
2. **Several origins** (two coplanar faces merged by `SimplifyResult`): the face takes the smallest name, and the others become **aliases**. An absorbed name therefore still resolves: `resolveName("f1/top")` returns the unified face.
3. **Generated face** (`Generated(edge | vertex | face)`): the feature gives it a name built from the name of the origin. For example, `fillet(e(…))` for a fillet.
4. **Split face** (several faces of the result with the same name): suffixes `#1`, `#2`… in the order of the centers of their bounding boxes (x, then y, then z, rounded to the micron). The plain name remains an alias of piece `#1`.
5. **No origin** (unexpected case): `<feature>/gen(?)`, then tie-break as in point 4.

Duplicate edge and vertex names (two edges between the same faces) are tie-broken the same way, by the midpoint of the edge.

## Where the names live
- `Body { TopoDS_Shape shape; TopoNames names; }`: each cached body keeps its names. Names are therefore free when going back in the tree.
- `TopoNames` stores a table face → { name, aliases } (hashed with `TopTools_ShapeMapHasher`, which ignores orientation). Edge and vertex names are computed on demand.
- Primitives name their faces by their role (`BRepPrimAPI_MakeBox::TopFace()`...). Extrusion and revolution name them by sketch curve (`Generated(edge)`, `FirstShape`, `LastShape`).
- Booleans, fillets and chamfers go through `TopoNames::derive`, with the history of the algorithm (`BRepTools_History(arguments, algo)`).

## Multiple bodies
A part can have several bodies (`core/part/bodies.cpp`, `core/document/engine.cpp`). The naming does not change form:
- **Identifier of a body**: that of the feature which created it (`Feature.id`). A feature that creates several bodies (split) gives `<feature>`, then `<feature>#2`, `<feature>#3`… in the geometric order of the pieces (center of the bounding box, as for split faces). The first piece remains the split body and keeps its identifier.
- **Uniqueness of names**: face names are prefixed by the identifier of the feature which created them, so they are already unique from one body to another. Two bodies created by two boxes have `f0/top` and `f1/top`.
- **Copy of a body** ("Déplacer un corps" with copy): each face of the copy is called `<feature>/copy(<original name>)`; the original body keeps its names. Without copy, the moved body keeps its names.
- **Combination of bodies**: union, subtraction and intersection go through `TopoNames::derive` on the target body and the tool bodies, like an ordinary boolean (aliases for merged faces, `gen(…)` for faces without origin).
- **Split by a plane**: the faces of the pieces keep their names; the cut faces are called `<feature>/plane`, tie-broken by `#k`. The names are computed on the whole cut, so they are unique across all the pieces.
- **Meshing**: a single mesh for the whole part; the faces and edges of each body have contiguous identifiers (`MeshPayload.bodies`), and `MeshPayload.names` covers all the bodies. The free edges of surfaces are listed in `MeshPayload.freeEdges`.
- **Surface bodies** (`core/part/surface.cpp`): surface extrusion and revolution name their faces `side(C)` by sketch curve, their start and end edges by the virtual end faces `start` and `end` (except for a full revolution, closed on itself), and their other free edges `e(F|~)#k`. A move keeps the explicit names of the edges; a copy renames them by their faces.
- **From surface to solid** (`core/part/solidify.cpp`): the faces of a thickened solid are named from their position relative to the sewn surface, not from the history of the offset, so the names do not depend on the algorithm that built the solid. In a symmetric thickening, `thick(F)` is the skin on the normal side and `base(F)` the other one. The faces of a cut are `cut(F)`, computed on the whole split like `plane`: one name shared by the two sides. A face replacement goes through two booleans (`TopoNames::derive`): the walls of the column usually merge with the faces they extend, whose names remain.
- **Designation groups** (`GeomRef.group`, `resolveGroup` in `core/part/refs.cpp`): each reference is looked up in its body (`GeomRef.body`), otherwise in all the bodies.

Limit: the order of the pieces of a split is geometric, as is that of the `#k` faces. If an upstream dimension makes one piece go in front of the other, the `<feature>#k` identifiers swap, and the features that target these bodies change target.

## Exposure to the client
- **`MeshPayload.names = { faces, edges }`** (SDK): `faces[id]` is the name of the face whose mesh identifier is `id` (third value of the triplets of `faceGroups`); the same for `edges` and `edgeGroups`. The same array is also in `WasmRecomputeResult.topology`.
- `resolveName(docId, name)`: mesh identifier of a face or edge of the current body, or -1 if it no longer exists. It is used to highlight a reference in the view.
- `featureAt` and `faceFeatures` read the origin feature from the prefix of the name (`featureOfFaceName`).

## References from features
`GeomRef.name` (SDK) carries the name of the designated element. The viewer fills it in at selection time from `MeshPayload.names` (`refpick.ts`), and also finds an element by its name (`matchRef`).

The kernel resolves in this order (`resolveRefs`, core/part/refs.cpp):
1. exact name, or alias;
2. fallback to the geometric signature (old documents, kernel without naming);
3. otherwise, an explicit error ("Arête introuvable…").

A "fillet on selected edges" feature thus survives a dimension change. It also survives the addition of an upstream hole that splits a face: `#1` remains designated by its alias. Edges projected into a sketch go through the same resolution.

## Known limits and next steps
- **Split faces**: the `#k` order is geometric. If a change makes one piece go in front of the other, the suffixes swap. It will have to be completed with the "cutting" face (the tool that did the split), as FreeCAD does (TNP, 1.0).
- **Bend on line, flattening**: the body is rebuilt from the state of the sheet. Its faces are named by rank (`sheet(k)`), so they are unstable if the sheet changes topology upstream. The geometry then serves as a fallback. To be reworked by propagating names in `SheetState`.
- **STEP import**: faces named by rank in the file (`face(k)`). This is stable, as long as the file does not change.
- **Faces without origin** (unexpected case): each feature names its remaining faces by rank, as a last resort, so that the whole body stays named.
- **Sketch identifiers**: the `side(curve)` names assume that the editor keeps the identifiers of the curves when the sketch is modified. This is the case today. It will have to be guaranteed for "trim", "cut" and "extend" (a curve cut in two: `l3` → `l3`, `l3.1`).
- **Cost**: edge names are computed at each recomputation for meshing (`MapShapesAndUniqueAncestors` and midpoints). This is negligible next to meshing, and they can be computed on demand if needed.

## Tests
- `core/tests/test_naming.cpp` (C++):
  - box: face roles, unique edges, `resolveName`;
  - cylinder: hole wall, seam;
  - name stability when dimensions change;
  - fillet (12 edge faces and 8 vertex faces);
  - merge with aliases;
  - face split into `#1` and `#2`;
  - extrusion (`side`, `start`, `end`).
- `packages/kernel-wasm/test/parity.test.ts` (same in WASM): alignment of names with mesh identifiers, stability, extrusion of a pierced sketch.
