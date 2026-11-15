// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Builders of the Part features and common tools.
#pragma once

#include "part/builder.hpp"

#include <TopAbs_ShapeEnum.hxx>
#include <TopoDS_Compound.hxx>

#include <optional>
#include <tuple>

namespace cad {

// Primitives (primitives.cpp)
FeatureOutput buildBox(const BuildContext& ctx);
FeatureOutput buildCylinder(const BuildContext& ctx);
// Fillets, chamfers, shell (dressup.cpp)
FeatureOutput buildFillet(const BuildContext& ctx);
FeatureOutput buildChamfer(const BuildContext& ctx);
FeatureOutput buildShell(const BuildContext& ctx);
// Draft from a neutral plane or a parting line (draft.cpp)
FeatureOutput buildDraft(const BuildContext& ctx);
// Sketch, extrude, thin extrude, revolve (sketch.cpp, sweep.cpp)
FeatureOutput buildSketch(const BuildContext& ctx);
/// 3D sketch: wires of its chains of lines and splines (`prepared.curves3d`, resolved by the client).
FeatureOutput buildSketch3D(const BuildContext& ctx);
FeatureOutput buildExtrude(const BuildContext& ctx);
FeatureOutput buildTwistExtrude(const BuildContext& ctx);
FeatureOutput buildThinExtrude(const BuildContext& ctx);
FeatureOutput buildRevolve(const BuildContext& ctx);
/// Revolve axis from the parameter `axis`: H or V axis of the sketch, or one of its lines.
gp_Ax1 revolveAxis(const BuildContext& ctx, const SketchProfile& s);
// Mirror, patterns (pattern.cpp)
FeatureOutput buildMirror(const BuildContext& ctx);
FeatureOutput buildLinearPattern(const BuildContext& ctx);
FeatureOutput buildCircularPattern(const BuildContext& ctx);
// Import STEP (import.cpp)
FeatureOutput buildImportStep(const BuildContext& ctx);
// Sweep, hole, slot, profiles (advanced.cpp)
FeatureOutput buildSweep(const BuildContext& ctx);
FeatureOutput buildHole(const BuildContext& ctx);
FeatureOutput buildSlot(const BuildContext& ctx);
FeatureOutput buildProfile(const BuildContext& ctx);
// Welded frame (frame.cpp)
FeatureOutput buildFrameMembers(const BuildContext& ctx);
// Sheet metal (sheetmetal.cpp)
FeatureOutput buildSheetBase(const BuildContext& ctx);
FeatureOutput buildEdgeFlange(const BuildContext& ctx);
FeatureOutput buildSheetCut(const BuildContext& ctx);
FeatureOutput buildSketchedBend(const BuildContext& ctx);
FeatureOutput buildSheetFlat(const BuildContext& ctx);
// Plugin features: geometric recipes (recipe.cpp)
FeatureOutput buildPluginRecipe(const BuildContext& ctx);
// Multi-body: combine, delete, move, split (bodies.cpp)
FeatureOutput buildCombineBodies(const BuildContext& ctx);
FeatureOutput buildDeleteBody(const BuildContext& ctx);
FeatureOutput buildMoveBody(const BuildContext& ctx);
FeatureOutput buildSplitBody(const BuildContext& ctx);
// Surfaces: surface extrude and surface revolve (surface.cpp)
FeatureOutput buildSurfaceExtrude(const BuildContext& ctx);
FeatureOutput buildSurfaceRevolve(const BuildContext& ctx);
// Sweep and loft, surface and solid (loft.cpp)
FeatureOutput buildSurfaceSweep(const BuildContext& ctx);
FeatureOutput buildSurfaceLoft(const BuildContext& ctx);
FeatureOutput buildLoft(const BuildContext& ctx);
// Planar surface and fill surface (fill.cpp)
FeatureOutput buildPlanarSurface(const BuildContext& ctx);
FeatureOutput buildFillSurface(const BuildContext& ctx);
// Offset, knit, trim, extend, extract faces (surfedit.cpp)
FeatureOutput buildOffsetSurface(const BuildContext& ctx);
FeatureOutput buildKnitSurface(const BuildContext& ctx);
FeatureOutput buildTrimSurface(const BuildContext& ctx);
FeatureOutput buildExtendSurface(const BuildContext& ctx);
FeatureOutput buildExtractFaces(const BuildContext& ctx);
// From surface to solid: thicken, close, cut, replace a face (solidify.cpp)
FeatureOutput buildThicken(const BuildContext& ctx);
FeatureOutput buildCloseSurface(const BuildContext& ctx);
FeatureOutput buildCutWithSurface(const BuildContext& ctx);
FeatureOutput buildReplaceFace(const BuildContext& ctx);

/// Wire of a section loop (Loop2D of @solidus-cad/sdk) placed in the plane (u, v) through `o`, with normal `n`.
TopoDS_Wire loopWire(const Json& loop, const gp_Pnt& o, const gp_Dir& u, const gp_Dir& v, const gp_Dir& n, bool reverse);
/// Face of a section (Section of @solidus-cad/sdk: outer outline and holes), repaired by ShapeFix.
TopoDS_Face sectionFace(const Json& section, const gp_Pnt& o, const gp_Dir& u, const gp_Dir& v, const gp_Dir& n);

/// Does the feature designate edges (TopAbs_EDGE) or faces (TopAbs_FACE)? (refs.cpp)
bool hasRefs(const BuildContext& ctx, TopAbs_ShapeEnum kind);
/// Sub-shapes of `body` designated by the references of the feature (default group: without `group`), in the order of
/// the references. Throws "Arête introuvable…" or "Face introuvable…" if one of them no longer matches anything.
std::vector<TopoDS_Shape> resolveRefs(const BuildContext& ctx, const Body& body, TopAbs_ShapeEnum kind);
/// Same for any list of references (edges projected into a sketch), limited to the group `group`.
std::vector<TopoDS_Shape> resolveRefs(const Json& refs, const Body& body, TopAbs_ShapeEnum kind, std::string_view group = {});
/// Element designated in a group (FeatureDefinition.refGroups): body where it was found, and sub-shape.
struct GroupRef {
  std::string body;
  TopoDS_Shape shape;
};
/// References of the group `group`, looked up in the body of each (`GeomRef.body`), otherwise in all bodies, in the
/// order of the references. Throws "Arête introuvable…" or "Face introuvable…".
std::vector<GroupRef> resolveGroup(const BuildContext& ctx, TopAbs_ShapeEnum kind, std::string_view group);
/// Identifiers separated by commas (parameters of kind "bodies"), without duplicates or empty entries.
std::vector<std::string> bodyIds(const std::string& list);
/// Centre of the bounding box, rounded to the micron: stable order of the pieces of a split.
std::tuple<double, double, double> shapeCenter(const TopoDS_Shape& s);
/// Reference resolution tolerance: tied to the deflection of the display mesh.
double refTolerance(const Body* body);

/// Adds a tool to the target body (op "add" or empty), removes it ("cut"), keeps their common part ("intersect")
/// or makes it a new body ("new", Body::created), then merges the coplanar faces.
/// `forceCut` forces the operation (hole: removal; import: addition). The tool is kept in Body::tool.
/// The face names are propagated through the operation's history.
Body combine(const BuildContext& ctx, Body tool, std::optional<bool> forceCut = std::nullopt);

/// Merges (or subtracts from the first) several named bodies: the names follow the history, the new faces are
/// named "<id>/<tag>(<origin>)". A single body: returned as is.
Body booleanNamed(const BuildContext& ctx, const std::vector<const Body*>& parts, bool cut, std::string_view tag);

/// Names the faces of `shape` by rank (TopExp::MapShapes): "<id>/<role>.<k>". For elementary parts whose topology
/// does not depend on dimensions (bend sector, plate, slot end).
void nameByRank(const BuildContext& ctx, TopoNames& names, const TopoDS_Shape& shape, const std::string& role);

/// Assembles shapes into a compound (no fusion).
TopoDS_Compound compoundOf(const std::vector<TopoDS_Shape>& shapes);

/// Maximum distance between `from` and the bounding box of the body (0 if no body).
double bodyReach(const Body* body, const gp_Pnt& from);

}  // namespace cad
