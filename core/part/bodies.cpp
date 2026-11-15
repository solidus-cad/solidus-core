// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Multi-body features: combine bodies, delete, move (or copy) and split a body.
// They act on the target body (`Feature.body`, otherwise the active body) and return a BodyChanges.
#include "part/features.hpp"

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepTools_History.hxx>
#include <Bnd_Box.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Pln.hxx>

#include <algorithm>
#include <cmath>
#include <memory>
#include <numbers>
#include <tuple>

namespace cad {
namespace {

const Body& target(const BuildContext& ctx) {
  const Body* b = ctx.prev();
  if (!b) throw FeatureError("Aucun corps cible");
  return *b;
}

gp_XYZ xyz(const Json& j) { return gp_XYZ(j.at(0).get<double>(), j.at(1).get<double>(), j.at(2).get<double>()); }

}  // namespace

std::vector<std::string> bodyIds(const std::string& s) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= s.size()) {
    const size_t end = std::min(s.find(',', start), s.size());
    std::string id = s.substr(start, end - start);
    id.erase(0, id.find_first_not_of(' '));
    id.erase(id.find_last_not_of(' ') + 1);
    if (!id.empty() && std::find(out.begin(), out.end(), id) == out.end()) out.push_back(std::move(id));
    start = end + 1;
  }
  return out;
}

std::tuple<double, double, double> shapeCenter(const TopoDS_Shape& s) {
  Bnd_Box box;
  BRepBndLib::Add(s, box, false);
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  auto r = [](double v) { return std::round(v * 1000) / 1000; };
  return {r((x0 + x1) / 2), r((y0 + y1) / 2), r((z0 + z1) / 2)};
}

/// Combines the target body with other bodies (`tools`): union (op "add"), subtraction ("cut") or common part
/// ("intersect"). The tool bodies disappear from the part, unless `keep` = "yes".
FeatureOutput buildCombineBodies(const BuildContext& ctx) {
  const Body& base = target(ctx);
  const std::vector<std::string> ids = bodyIds(ctx.str("tools"));
  if (ids.empty()) throw FeatureError("Aucun corps à combiner");
  std::vector<const Body*> tools;
  for (const std::string& id : ids) {
    if (id == ctx.targetId()) throw FeatureError("Un corps ne peut pas se combiner avec lui-même");
    tools.push_back(&ctx.body(id));
    if (tools.back()->kind == BodyKind::Surface) throw FeatureError("Un corps outil est une surface : choisissez des corps solides");
  }
  const std::string op = ctx.str("op");
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> algo;
  if (op == "cut")
    algo = std::make_unique<BRepAlgoAPI_Cut>();
  else if (op == "intersect")
    algo = std::make_unique<BRepAlgoAPI_Common>();
  else
    algo = std::make_unique<BRepAlgoAPI_Fuse>();
  TopTools_ListOfShape args, toolShapes, all;
  args.Append(base.shape);
  all.Append(base.shape);
  for (const Body* t : tools) {
    toolShapes.Append(t->shape);
    all.Append(t->shape);
  }
  algo->SetArguments(args);
  algo->SetTools(toolShapes);
  algo->Build();
  if (!algo->IsDone() || algo->HasErrors()) throw FeatureError("L'opération booléenne a échoué");
  algo->SimplifyResult(true, true);
  BRepTools_History history(all, *algo);
  std::vector<TopoNames::Input> inputs{{&base.shape, &base.names}};
  for (const Body* t : tools) inputs.push_back({&t->shape, &t->names});
  Body out;
  out.shape = algo->Shape();
  out.names = TopoNames::derive(out.shape, inputs, history, [&](const std::string& origin) { return ctx.name("gen(" + origin + ")"); });
  BodyChanges changes;
  changes.target = std::move(out);
  if (ctx.str("keep") != "yes") changes.removed = ids;
  return changes;
}

/// Removes the target body from the part.
FeatureOutput buildDeleteBody(const BuildContext& ctx) {
  target(ctx);
  BodyChanges changes;
  changes.removeTarget = true;
  return changes;
}

/// Moves the target body: rotation `angle` (°) around the axis `axis` (X, Y or Z) through the origin, then
/// translation (dx, dy, dz). With `copy` = "yes", the body stays in place and the moved copy becomes a new body
/// (faces "copy(<origin name>)").
FeatureOutput buildMoveBody(const BuildContext& ctx) {
  const Body& base = target(ctx);
  const double angle = ctx.num("angle") * std::numbers::pi / 180;
  const std::string a = ctx.str("axis");
  const gp_Dir axis = a == "X" ? gp::DX() : a == "Y" ? gp::DY() : gp::DZ();
  gp_Trsf rotation, translation;
  rotation.SetRotation(gp_Ax1(gp::Origin(), axis), angle);
  translation.SetTranslation(gp_Vec(ctx.num("dx"), ctx.num("dy"), ctx.num("dz")));
  const bool copy = ctx.str("copy") == "yes";
  BRepBuilderAPI_Transform tr(base.shape, translation * rotation, true, false);
  Body moved;
  moved.shape = tr.Shape();
  moved.kind = base.kind;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(base.shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++)
    if (const std::string* n = base.names.face(faces(i))) moved.names.set(tr.ModifiedShape(faces(i)), copy ? ctx.name("copy(" + *n + ")") : *n);
  // Surface boundaries: explicit names are kept by a move; a copy renames them by their faces ("e(F|~)").
  if (!copy)
    for (const auto& [edge, name] : base.names.explicitEdges()) moved.names.setEdge(tr.ModifiedShape(edge), name);
  BodyChanges changes;
  if (copy)
    changes.created.push_back(std::move(moved));
  else
    changes.target = std::move(moved);
  return changes;
}

/// Splits the target body by a plane (`prepared.frame` = { origin, normal }, resolved by the client like the mirror):
/// each piece becomes a body. The first one (order of centres: x, then y, then z) keeps the identifier of the target
/// body, the others are new. Cut faces: "<function>/plane", told apart as #k.
FeatureOutput buildSplitBody(const BuildContext& ctx) {
  const Body& base = target(ctx);
  ctx.num("offset");
  const Json& prepared = ctx.feature().prepared;
  const auto frame = prepared.find("frame");
  if (frame == prepared.end()) throw FeatureError("Plan introuvable ou en erreur");
  const gp_Pnt origin(xyz(frame->at("origin")));
  const gp_Pln plane(origin, gp_Dir(xyz(frame->at("normal"))));
  // Planar face large enough to cross the whole body.
  const double size = bodyReach(&base, origin) * 2 + 1;
  const TopoDS_Face cutter = BRepBuilderAPI_MakeFace(plane, -size, size, -size, size).Face();
  BRepAlgoAPI_Splitter splitter;
  TopTools_ListOfShape args, tools, all;
  args.Append(base.shape);
  tools.Append(cutter);
  all.Append(base.shape);
  all.Append(cutter);
  splitter.SetArguments(args);
  splitter.SetTools(tools);
  splitter.Build();
  if (!splitter.IsDone() || splitter.HasErrors()) throw FeatureError("La découpe a échoué");
  std::vector<TopoDS_Shape> pieces;
  for (TopExp_Explorer ex(splitter.Shape(), TopAbs_SOLID); ex.More(); ex.Next()) pieces.push_back(ex.Current());
  if (pieces.size() < 2) throw FeatureError("Le plan ne coupe pas le corps");
  TopoNames cutterNames;
  cutterNames.set(cutter, ctx.name("plane"));
  BRepTools_History history(all, splitter);
  const TopoNames names = TopoNames::derive(splitter.Shape(), {{&base.shape, &base.names}, {&cutter, &cutterNames}}, history,
                                            [&](const std::string& origin) { return ctx.name("gen(" + origin + ")"); });
  std::stable_sort(pieces.begin(), pieces.end(), [](const TopoDS_Shape& a, const TopoDS_Shape& b) { return shapeCenter(a) < shapeCenter(b); });
  BodyChanges changes;
  for (size_t k = 0; k < pieces.size(); k++) {
    Body piece;
    piece.shape = pieces[k];
    // The names are those of the whole split (unique across all pieces); each body only reads its own faces.
    piece.names = names;
    if (k == 0)
      changes.target = std::move(piece);
    else
      changes.created.push_back(std::move(piece));
  }
  return changes;
}

}  // namespace cad
