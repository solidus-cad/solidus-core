// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Fillets, chamfers and shell. The created faces are named by the element they come from:
//   - fillet, chamfer: by the edge (or the vertex), "<id>/fillet(e(A|B))";
//   - shell: by the offset face, "<id>/shell(A)".
#include "part/features.hpp"

#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepTools_History.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>

namespace cad {
namespace {

/// Body resulting from an operation on `prev`, named by its history.
template <class Algo>
Body named(const BuildContext& ctx, const Body& prev, Algo& mk, std::string_view tag) {
  TopTools_ListOfShape args;
  args.Append(prev.shape);
  BRepTools_History history(args, mk);
  Body out;
  out.shape = mk.Shape();
  const std::string prefix = std::string(tag) + "(";
  out.names = TopoNames::derive(out.shape, {{&prev.shape, &prev.names}}, history,
                                [&](const std::string& origin) { return ctx.name(prefix + origin + ")"); });
  return out;
}

template <class Algo>
Body finish(const BuildContext& ctx, const Body& prev, Algo& mk, std::string_view tag) {
  mk.Build();
  if (!mk.IsDone()) throw FeatureError(std::string(tag == "fillet" ? "Le congé" : "Le chanfrein") + " a échoué");
  return named(ctx, prev, mk, tag);
}

/// Designated edges (references), or all the edges if none is designated.
template <class Fn>
void withEdges(const BuildContext& ctx, const Body& prev, Fn add) {
  if (!hasRefs(ctx, TopAbs_EDGE)) {
    TopTools_IndexedMapOfShape edges;
    TopExp::MapShapes(prev.shape, TopAbs_EDGE, edges);
    for (int i = 1; i <= edges.Extent(); i++) add(TopoDS::Edge(edges(i)));
    return;
  }
  for (const TopoDS_Shape& e : resolveRefs(ctx, prev, TopAbs_EDGE)) add(TopoDS::Edge(e));
}

}  // namespace

FeatureOutput buildFillet(const BuildContext& ctx) {
  const Body* prev = ctx.prev();
  if (!prev) throw FeatureError("Aucun corps sur lequel appliquer le congé");
  const double r = ctx.positive("radius");
  BRepFilletAPI_MakeFillet mk(prev->shape);
  withEdges(ctx, *prev, [&](const TopoDS_Edge& e) { mk.Add(r, e); });
  return finish(ctx, *prev, mk, "fillet");
}

FeatureOutput buildChamfer(const BuildContext& ctx) {
  const Body* prev = ctx.prev();
  if (!prev) throw FeatureError("Aucun corps sur lequel appliquer le chanfrein");
  const double d = ctx.positive("distance");
  BRepFilletAPI_MakeChamfer mk(prev->shape);
  withEdges(ctx, *prev, [&](const TopoDS_Edge& e) { mk.Add(d, e); });
  return finish(ctx, *prev, mk, "chamfer");
}

/// Shell: hollows out the body keeping a constant thickness; the designated faces are removed (opened).
FeatureOutput buildShell(const BuildContext& ctx) {
  const Body* prev = ctx.prev();
  if (!prev) throw FeatureError("Aucun corps à évider");
  const double t = ctx.positive("thickness");
  TopTools_ListOfShape open;
  for (const TopoDS_Shape& f : resolveRefs(ctx, *prev, TopAbs_FACE)) open.Append(f);
  // Thickness toward the inside: negative offset.
  const double sign = ctx.str("direction") == "outside" ? 1 : -1;
  BRepOffsetAPI_MakeThickSolid mk;
  mk.MakeThickSolidByJoin(prev->shape, open, sign * t, 1e-3, BRepOffset_Skin, false, false, GeomAbs_Intersection, false);
  if (!mk.IsDone()) throw FeatureError("La coque a échoué (épaisseur trop grande par rapport aux rayons ?)");
  return named(ctx, *prev, mk, "shell");
}

}  // namespace cad
