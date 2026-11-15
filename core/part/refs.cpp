// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Resolution of the references (GeomRef) to the edges and faces designated in the view.
// The element kept is the one that passes through the stored point
// and whose size (length, area) is the closest. If the reference carries a topological name (`name`,
// core/NAMING.md), it is resolved first; the geometric signature serves as a fallback.
#include "mesh/mesh.hpp"
#include "part/features.hpp"

#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Vertex.hxx>

#include <algorithm>
#include <cmath>
#include <limits>
#include <optional>

namespace cad {
namespace {

const char* kindName(TopAbs_ShapeEnum kind) { return kind == TopAbs_EDGE ? "edge" : "face"; }

double sizeOf(const TopoDS_Shape& s, TopAbs_ShapeEnum kind) {
  GProp_GProps g;
  if (kind == TopAbs_EDGE)
    BRepGProp::LinearProperties(s, g);
  else
    BRepGProp::SurfaceProperties(s, g);
  return g.Mass();
}

double distance(const TopoDS_Vertex& v, const TopoDS_Shape& s) {
  BRepExtrema_DistShapeShape d(v, s);
  return d.IsDone() ? d.Value() : std::numeric_limits<double>::infinity();
}

}  // namespace

bool hasRefs(const BuildContext& ctx, TopAbs_ShapeEnum kind) {
  const Json& refs = ctx.feature().refs;
  if (!refs.is_array()) return false;
  return std::any_of(refs.begin(), refs.end(), [&](const Json& r) { return r.value("kind", "") == kindName(kind) && r.value("group", "").empty(); });
}

double refTolerance(const Body* body) { return body ? std::max(defaultDeflection(body->shape) * 4, 1e-3) : 1e-3; }

std::vector<TopoDS_Shape> resolveRefs(const BuildContext& ctx, const Body& body, TopAbs_ShapeEnum kind) {
  return resolveRefs(ctx.feature().refs, body, kind);
}

std::vector<TopoDS_Shape> resolveRefs(const Json& refs, const Body& body, TopAbs_ShapeEnum kind, std::string_view group) {
  std::vector<TopoDS_Shape> picked;
  if (!refs.is_array()) return picked;
  // Distinct sub-shapes: an edge shared by two faces appears only once.
  TopTools_IndexedMapOfShape candidates;
  TopExp::MapShapes(body.shape, kind, candidates);
  std::vector<std::optional<double>> sizes(candidates.Extent() + 1);
  std::vector<bool> taken(candidates.Extent() + 1, false);
  const double tol = refTolerance(&body);

  for (const Json& ref : refs) {
    if (ref.value("kind", "") != kindName(kind) || ref.value("group", "") != group) continue;
    int best = 0;
    if (const auto it = ref.find("name"); it != ref.end() && it->is_string()) {
      if (const std::optional<TopoDS_Shape> found = body.names.find(body.shape, it->get<std::string>());
          found && found->ShapeType() == kind) {
        const int i = candidates.FindIndex(*found);
        if (i > 0 && !taken[i]) best = i;
      }
    }
    if (best == 0) {
      const Json& p = ref.at("p");
      const TopoDS_Vertex v =
          BRepBuilderAPI_MakeVertex(gp_Pnt(p.at(0).get<double>(), p.at(1).get<double>(), p.at(2).get<double>())).Vertex();
      const double refSize = ref.value("size", 0.0);
      double bestScore = std::numeric_limits<double>::infinity();
      for (int i = 1; i <= candidates.Extent(); i++) {
        if (taken[i]) continue;
        const double d = distance(v, candidates(i));
        if (d > tol) continue;
        if (!sizes[i]) sizes[i] = sizeOf(candidates(i), kind);
        const double score = d / tol + std::abs(*sizes[i] - refSize) / std::max(refSize, 1e-6);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    if (best == 0)
      throw FeatureError(kind == TopAbs_EDGE ? "Arête introuvable : le modèle a changé en amont, sélectionnez-la à nouveau"
                                             : "Face introuvable : le modèle a changé en amont, sélectionnez-la à nouveau");
    taken[best] = true;
    picked.push_back(candidates(best));
  }
  return picked;
}

std::vector<GroupRef> resolveGroup(const BuildContext& ctx, TopAbs_ShapeEnum kind, std::string_view group) {
  std::vector<GroupRef> out;
  const Json& refs = ctx.feature().refs;
  if (!refs.is_array()) return out;
  for (const Json& ref : refs) {
    if (ref.value("kind", "") != kindName(kind) || ref.value("group", "") != group) continue;
    const std::string wanted = ref.value("body", "");
    const Json one = Json::array({ref});
    std::optional<GroupRef> found;
    std::string error;
    for (const auto& [id, body] : ctx.bodies()) {
      if (!wanted.empty() && id != wanted) continue;
      try {
        const std::vector<TopoDS_Shape> s = resolveRefs(one, *body, kind, group);
        if (!s.empty()) found = GroupRef{id, s.front()};
      } catch (const FeatureError& e) {
        error = e.what();
      }
      if (found) break;
    }
    if (!found)
      throw FeatureError(error.empty() ? (kind == TopAbs_EDGE ? "Arête introuvable : le modèle a changé en amont, sélectionnez-la à nouveau"
                                                              : "Face introuvable : le modèle a changé en amont, sélectionnez-la à nouveau")
                                       : error);
    out.push_back(std::move(*found));
  }
  return out;
}

}  // namespace cad
