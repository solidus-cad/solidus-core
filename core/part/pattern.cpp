// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Mirror and patterns: transformed copies of a feature's tool (or of the whole body), combined with the body
// using the operation of the original feature.
// Naming: face F of copy k is "<id>/copy<k>(F)" (k >= 1; the original keeps its names).
#include "part/features.hpp"

#include <BRepBuilderAPI_Transform.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Trsf.hxx>

#include <cmath>
#include <numbers>
#include <optional>

namespace cad {
namespace {

/// Tool to repeat: that of a feature, or the whole body if no feature is chosen.
std::shared_ptr<const Tool> source(const BuildContext& ctx) {
  if (ctx.str("feature").empty()) {
    const Body* prev = ctx.prev();
    if (!prev) throw FeatureError("Aucun corps à répéter");
    return std::make_shared<const Tool>(Tool{prev->shape, prev->names, false});
  }
  return ctx.featureTool("feature");
}

/// Combines transformed copies of the source tool, with its operation (addition or removal).
Body repeat(const BuildContext& ctx, const std::vector<gp_Trsf>& copies) {
  const std::shared_ptr<const Tool> src = source(ctx);
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(src->shape, TopAbs_FACE, faces);
  std::vector<TopoDS_Shape> shapes;
  Body tool;
  for (size_t k = 0; k < copies.size(); k++) {
    BRepBuilderAPI_Transform tr(src->shape, copies[k], true, false);
    shapes.push_back(tr.Shape());
    const std::string prefix = "copy" + std::to_string(k + 1) + "(";
    for (int i = 1; i <= faces.Extent(); i++)
      if (const std::string* n = src->names.face(faces(i))) tool.names.set(tr.ModifiedShape(faces(i)), ctx.name(prefix + *n + ")"));
  }
  tool.shape = compoundOf(shapes);
  return combine(ctx, std::move(tool), src->cut);
}

gp_Dir axis(const std::string& name, const gp_Dir& fallback) {
  if (name == "X") return gp::DX();
  if (name == "Y") return gp::DY();
  if (name == "Z") return gp::DZ();
  return fallback;
}

/// Rounds to the nearest value, like Math.round (halves toward +∞).
int count(const BuildContext& ctx, std::string_view key) {
  const int n = static_cast<int>(std::floor(ctx.num(key) + 0.5));
  if (n < 1 || n > 500) throw FeatureError("Le nombre d'occurrences doit être compris entre 1 et 500");
  return n;
}

gp_XYZ xyz(const Json& j) { return gp_XYZ(j.at(0).get<double>(), j.at(1).get<double>(), j.at(2).get<double>()); }

}  // namespace

/// Mirror about a base or reference plane, offset by `offset`. The frame of the plane is resolved by the
/// client (reference planes: @solidus-cad/sdk) and received in `prepared.frame` = { origin, normal }.
FeatureOutput buildMirror(const BuildContext& ctx) {
  ctx.num("offset");
  const Json& prepared = ctx.feature().prepared;
  const auto frame = prepared.find("frame");
  if (frame == prepared.end()) throw FeatureError("Plan introuvable ou en erreur");
  gp_Trsf t;
  t.SetMirror(gp_Ax2(gp_Pnt(xyz(frame->at("origin"))), gp_Dir(xyz(frame->at("normal")))));
  return repeat(ctx, {t});
}

FeatureOutput buildLinearPattern(const BuildContext& ctx) {
  const gp_Vec d1 = gp_Vec(axis(ctx.str("direction"), gp::DX())) * (ctx.str("reverse") == "yes" ? -1 : 1);
  const int n1 = count(ctx, "count");
  const double s1 = ctx.num("spacing");
  const std::string second = ctx.str("direction2");
  const bool two = second == "X" || second == "Y" || second == "Z";
  const gp_Vec d2 = two ? gp_Vec(axis(second, gp::DX())) : gp_Vec(0, 0, 0);
  const int n2 = two ? count(ctx, "count2") : 1;
  const double s2 = two ? ctx.num("spacing2") : 0;
  std::vector<gp_Trsf> copies;
  for (int i = 0; i < n1; i++) {
    for (int j = 0; j < n2; j++) {
      if (i == 0 && j == 0) continue;
      gp_Trsf t;
      t.SetTranslation(d1 * (i * s1) + d2 * (j * s2));
      copies.push_back(t);
    }
  }
  if (copies.empty()) throw FeatureError("La matrice doit contenir au moins deux occurrences");
  return repeat(ctx, copies);
}

FeatureOutput buildCircularPattern(const BuildContext& ctx) {
  const gp_Dir ax = axis(ctx.str("axis"), gp::DZ());
  const int n = count(ctx, "count");
  if (n < 2) throw FeatureError("La matrice doit contenir au moins deux occurrences");
  const double total = ctx.num("angle");
  if (total <= 0 || total > 360) throw FeatureError("L'angle doit être compris entre 0 et 360°");
  // 360°: spread over the full turn; otherwise the last instance is at the given angle.
  const double step = (total >= 360 ? total / n : total / (n - 1)) * std::numbers::pi / 180;
  std::vector<gp_Trsf> copies;
  for (int k = 1; k < n; k++) {
    gp_Trsf t;
    t.SetRotation(gp_Ax1(gp::Origin(), ax), step * k);
    copies.push_back(t);
  }
  return repeat(ctx, copies);
}

}  // namespace cad
