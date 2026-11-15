// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Surface extrude and surface revolve: the curves of a sketch (open chains and closed outlines) are swept
// without closing a volume; the result is a new body of kind "surface". Naming:
//   - face from the sketch curve C: "<id>/side(C)";
//   - free start and end edges (the curve C and its swept copy): through a virtual end face,
//     "e(<id>/side(C)|<id>/start)" and "e(<id>/end|<id>/side(C))" (face names sorted, see core/NAMING.md);
//   - free lateral edges (swept by the end of an open chain): "e(<id>/side(C)|~)", told apart as #k.
#include "part/features.hpp"

#include <BRepBuilderAPI_Transform.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRep_Builder.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Compound.hxx>

#include <numbers>
#include <optional>

namespace cad {
namespace {

/// Sketch curves to sweep: edges of the open chains and of the closed outlines, each once (an edge
/// shared by two neighbouring regions is swept only once).
TopoDS_Compound sketchEdges(const SketchProfile& s) {
  TopTools_IndexedMapOfShape edges;
  for (const TopoDS_Wire& w : s.wires) TopExp::MapShapes(w, TopAbs_EDGE, edges);
  for (const TopoDS_Face& f : s.faces) TopExp::MapShapes(f, TopAbs_EDGE, edges);
  if (edges.IsEmpty()) throw FeatureError("L'esquisse ne contient aucune courbe");
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  for (int i = 1; i <= edges.Extent(); i++) b.Add(c, edges(i));
  return c;
}

/// Names of a swept surface: faces per sketch curve, start and end edges named explicitly.
/// `edgeOf` gives the swept edge corresponding to an edge of the sketch; `ends`: the sweep has start and end edges
/// (false for a full revolution, closed on itself).
template <class Sweep, class EdgeOf>
TopoNames surfaceNames(const BuildContext& ctx, const SketchProfile& s, const TopoDS_Shape& edges, Sweep& mk, EdgeOf edgeOf, bool ends) {
  TopoNames names;
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(edges, TopAbs_EDGE, map);
  for (int i = 1; i <= map.Extent(); i++) {
    const auto curve = s.edgeCurves.find(map(i));
    if (curve == s.edgeCurves.end()) continue;
    const std::string side = ctx.name("side(" + curve->second + ")");
    const TopoDS_Shape swept = edgeOf(map(i));
    for (const TopoDS_Shape& f : mk.Generated(swept))
      if (f.ShapeType() == TopAbs_FACE) names.set(f, side);
    if (!ends) continue;
    const TopoDS_Shape first = mk.FirstShape(swept);
    const TopoDS_Shape last = mk.LastShape(swept);
    if (!first.IsNull()) names.setEdge(first, TopoNames::edgeName({side, ctx.name("start")}));
    if (!last.IsNull()) names.setEdge(last, TopoNames::edgeName({side, ctx.name("end")}));
  }
  return names;
}

Body surfaceBody(TopoDS_Shape shape, TopoNames names) {
  Body out;
  out.shape = std::move(shape);
  out.names = std::move(names);
  out.created = true;
  out.kind = BodyKind::Surface;
  return out;
}

}  // namespace

/// Surface extrusion normal to the sketch plane: `mode` = "blind" (height `depth`, direction reversed by
/// `reverse`), "symmetric" (`depth` split between both sides) or "twoSides" (`depth` on one side, `depth2` on the other).
FeatureOutput buildSurfaceExtrude(const BuildContext& ctx) {
  const SketchProfile& s = ctx.sketch("sketch");
  const TopoDS_Compound edges = sketchEdges(s);
  const std::string mode = ctx.str("mode");
  const double sign = ctx.str("reverse") == "yes" ? -1 : 1;
  const double depth = ctx.positive("depth");
  // Offset of the start, opposite to the extrusion direction, and total length.
  double back = 0, length = depth;
  if (mode == "symmetric") {
    back = depth / 2;
  } else if (mode == "twoSides") {
    back = ctx.positive("depth2");
    length = depth + back;
  }
  const gp_Dir n = s.frame.Direction();
  TopoDS_Shape base = edges;
  std::optional<BRepBuilderAPI_Transform> moved;
  if (back > 0) {
    gp_Trsf t;
    t.SetTranslation(gp_Vec(n) * (-sign * back));
    moved.emplace(edges, t, true, false);
    base = moved->Shape();
  }
  BRepPrimAPI_MakePrism mk(base, gp_Vec(n) * (sign * length), false, true);
  if (!mk.IsDone()) throw FeatureError("L'extrusion surfacique a échoué");
  const auto edgeOf = [&](const TopoDS_Shape& e) { return moved ? moved->ModifiedShape(e) : e; };
  return surfaceBody(mk.Shape(), surfaceNames(ctx, s, edges, mk, edgeOf, true));
}

/// Surface revolve of the sketch curves around `axis`, by an angle `angle` (°, 0 < angle <= 360).
FeatureOutput buildSurfaceRevolve(const BuildContext& ctx) {
  const SketchProfile& s = ctx.sketch("sketch");
  const double angle = ctx.num("angle");
  if (angle <= 0 || angle > 360) throw FeatureError("L'angle doit être compris entre 0 et 360°");
  const gp_Ax1 ax = revolveAxis(ctx, s);
  const TopoDS_Compound edges = sketchEdges(s);
  BRepPrimAPI_MakeRevol mk(edges, ax, angle * std::numbers::pi / 180, false);
  if (!mk.IsDone()) throw FeatureError("La révolution surfacique a échoué");
  const auto same = [](const TopoDS_Shape& e) { return e; };
  return surfaceBody(mk.Shape(), surfaceNames(ctx, s, edges, mk, same, angle < 360));
}

}  // namespace cad
