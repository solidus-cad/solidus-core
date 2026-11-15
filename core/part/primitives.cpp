// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "part/features.hpp"

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrim_Cylinder.hxx>
#include <BRepTools_History.hxx>
#include <BRep_Builder.hxx>
#include <Bnd_Box.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS_Iterator.hxx>

#include <algorithm>
#include <cmath>
#include <memory>

namespace cad {

Body combine(const BuildContext& ctx, Body tool, std::optional<bool> forceCut) {
  const Body* prev = ctx.prev();
  const std::string op = forceCut ? std::string() : ctx.str("op");
  const bool cut = forceCut ? *forceCut : op == "cut";
  const bool common = op == "intersect";
  // The tool is kept: the mirror and pattern features reuse it.
  auto kept = std::make_shared<const Tool>(Tool{tool.shape, tool.names, cut});
  // New body: the tool becomes a body of the part, the target body stays as it is.
  if (op == "new" || !prev) {
    if (cut) throw FeatureError("Aucune matière à enlever");
    if (common) throw FeatureError("Aucun corps à intersecter");
    tool.tool = std::move(kept);
    tool.created = prev != nullptr;
    return tool;
  }
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> algo;
  if (cut)
    algo = std::make_unique<BRepAlgoAPI_Cut>();
  else if (common)
    algo = std::make_unique<BRepAlgoAPI_Common>();
  else
    algo = std::make_unique<BRepAlgoAPI_Fuse>();
  TopTools_ListOfShape args, tools;
  args.Append(prev->shape);
  // Compound tool (copies of a pattern or a mirror): each element is a distinct tool. Grouped into a single
  // argument, overlapping elements (pattern step smaller than the tool) form an invalid input for the boolean
  // operation, which then exhausted the memory and stopped the kernel.
  if (tool.shape.ShapeType() == TopAbs_COMPOUND)
    for (TopoDS_Iterator it(tool.shape); it.More(); it.Next()) tools.Append(it.Value());
  else
    tools.Append(tool.shape);
  algo->SetArguments(args);
  algo->SetTools(tools);
  algo->Build();
  if (!algo->IsDone() || algo->HasErrors()) throw FeatureError("L'opération booléenne a échoué");
  // Equivalent of ShapeUpgrade_UnifySameDomain(shape, true, true, false), with the merged history.
  algo->SimplifyResult(true, true);

  TopTools_ListOfShape all;
  all.Append(prev->shape);
  for (const TopoDS_Shape& t : tools) all.Append(t);
  BRepTools_History history(all, *algo);
  Body out;
  out.shape = algo->Shape();
  out.names = TopoNames::derive(out.shape, {{&prev->shape, &prev->names}, {&tool.shape, &tool.names}}, history,
                                [&](const std::string& origin) { return ctx.name("gen(" + origin + ")"); });
  out.tool = std::move(kept);
  return out;
}

Body booleanNamed(const BuildContext& ctx, const std::vector<const Body*>& parts, bool cut, std::string_view tag) {
  if (parts.empty()) throw FeatureError("Aucune géométrie à assembler");
  if (parts.size() == 1) return *parts.front();
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> algo;
  if (cut)
    algo = std::make_unique<BRepAlgoAPI_Cut>();
  else
    algo = std::make_unique<BRepAlgoAPI_Fuse>();
  TopTools_ListOfShape args, tools, all;
  args.Append(parts.front()->shape);
  for (size_t i = 1; i < parts.size(); i++) tools.Append(parts[i]->shape);
  for (const Body* p : parts) all.Append(p->shape);
  algo->SetArguments(args);
  algo->SetTools(tools);
  algo->Build();
  if (!algo->IsDone() || algo->HasErrors()) throw FeatureError("L'opération booléenne a échoué");
  algo->SimplifyResult(true, true);
  BRepTools_History history(all, *algo);
  std::vector<TopoNames::Input> inputs;
  for (const Body* p : parts) inputs.push_back({&p->shape, &p->names});
  Body out;
  out.shape = algo->Shape();
  const std::string prefix = std::string(tag) + "(";
  out.names = TopoNames::derive(out.shape, inputs, history, [&](const std::string& origin) { return ctx.name(prefix + origin + ")"); });
  return out;
}

void nameByRank(const BuildContext& ctx, TopoNames& names, const TopoDS_Shape& shape, const std::string& role) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++) names.set(faces(i), ctx.name(role + "." + std::to_string(i)));
}

TopoDS_Compound compoundOf(const std::vector<TopoDS_Shape>& shapes) {
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  for (const TopoDS_Shape& s : shapes) b.Add(c, s);
  return c;
}

double bodyReach(const Body* body, const gp_Pnt& from) {
  if (!body) return 0;
  Bnd_Box box;
  BRepBndLib::Add(body->shape, box, false);
  if (box.IsVoid()) return 0;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  auto farthest = [](double a, double b, double p) { return std::max(std::abs(a - p), std::abs(b - p)); };
  return std::hypot(farthest(x0, x1, from.X()), farthest(y0, y1, from.Y()), farthest(z0, z1, from.Z()));
}

// Parameters evaluated in order (x, y, z): the first one in error is the one reported.
static gp_Pnt point(const BuildContext& ctx) {
  const double x = ctx.num("x");
  const double y = ctx.num("y");
  const double z = ctx.num("z");
  return gp_Pnt(x, y, z);
}

FeatureOutput buildBox(const BuildContext& ctx) {
  const gp_Pnt origin = point(ctx);
  const double width = ctx.positive("width");
  const double depth = ctx.positive("depth");
  const double height = ctx.positive("height");
  BRepPrimAPI_MakeBox mk(origin, width, depth, height);
  Body tool;
  tool.shape = mk.Shape();
  tool.names.set(mk.BottomFace(), ctx.name("bottom"));
  tool.names.set(mk.TopFace(), ctx.name("top"));
  // Names follow the application's views (front view from -Y), not OCCT's (FrontFace = XMax, LeftFace = YMin).
  tool.names.set(mk.LeftFace(), ctx.name("front"));   // YMin
  tool.names.set(mk.RightFace(), ctx.name("back"));   // YMax
  tool.names.set(mk.BackFace(), ctx.name("left"));    // XMin
  tool.names.set(mk.FrontFace(), ctx.name("right"));  // XMax
  return combine(ctx, std::move(tool));
}

FeatureOutput buildCylinder(const BuildContext& ctx) {
  const std::string axis = ctx.str("axis");
  gp_Dir dir;
  if (axis == "x")
    dir = gp::DX();
  else if (axis == "y")
    dir = gp::DY();
  else if (axis == "z")
    dir = gp::DZ();
  else
    throw FeatureError("Axe inconnu");
  const gp_Ax2 ax(point(ctx), dir);
  const double radius = ctx.positive("radius");
  const double height = ctx.positive("height");
  BRepPrimAPI_MakeCylinder mk(ax, radius, height);
  Body tool;
  tool.shape = mk.Shape();
  BRepPrim_Cylinder& prim = mk.Cylinder();
  tool.names.set(prim.LateralFace(), ctx.name("lateral"));
  tool.names.set(prim.TopFace(), ctx.name("top"));
  tool.names.set(prim.BottomFace(), ctx.name("bottom"));
  return combine(ctx, std::move(tool));
}

}  // namespace cad
