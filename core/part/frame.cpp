// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Welded frame: one step (`frameMembers`) places one profile per line of the skeleton. Port of frame.ts.
// The placement and end cuts are computed by the client (layoutFrame of @solidus-cad/sdk, over all the steps
// up to this one) and received in `prepared.members` (MemberLayout[]); the kernel builds each bar: prism of
// the section, trimmed by its two end planes. The profiles remain distinct bodies (compound, no fusion).
// Naming: faces of the profile "<id>/member(<line key>.i)".
#include "part/features.hpp"

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepTools_History.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>

#include <algorithm>
#include <cmath>

namespace cad {
namespace {

gp_XYZ xyz(const Json& j) { return gp_XYZ(j.at(0).get<double>(), j.at(1).get<double>(), j.at(2).get<double>()); }

/// Removes from `shape` the half-space behind the plane (side opposite to the normal), within a box of side `size`.
TopoDS_Shape trim(const TopoDS_Shape& shape, const Json& plane, double size) {
  const gp_Dir n(xyz(plane.at("n")));
  const gp_Dir x = n.Crossed(std::abs(n.Z()) < 0.9 ? gp::DZ() : gp::DX());
  // Box placed on the plane, on the side to remove: main axis -n, axes X = x and Y = (-n) x x.
  const gp_Dir y = n.Reversed().Crossed(x);
  const gp_Pnt corner = gp_Pnt(xyz(plane.at("p"))).Translated(gp_Vec(x) * (-size / 2) + gp_Vec(y) * (-size / 2));
  BRepPrimAPI_MakeBox box(gp_Ax2(corner, n.Reversed(), x), size, size, size);
  BRepAlgoAPI_Cut cut(shape, box.Shape());
  if (!cut.IsDone()) throw FeatureError("La coupe d'extrémité d'un profilé a échoué");
  return cut.Shape();
}

double loopReach(const Json& loop) {
  if (loop.at("kind") == "circle") return std::hypot(loop.at("c").at(0).get<double>(), loop.at("c").at(1).get<double>()) + loop.at("r").get<double>();
  double r = 0;
  for (const Json& p : loop.at("pts")) r = std::max(r, std::hypot(p.at(0).get<double>(), p.at(1).get<double>()));
  return r;
}

TopoDS_Shape memberSolid(const Json& m) {
  const Json& offset = m.at("offset");
  const double ou = offset.at(0).get<double>(), ov = offset.at(1).get<double>();
  const double reach = loopReach(m.at("section").at("outer")) + std::hypot(ou, ov);
  // Raw bar extended at both ends, then trimmed by the end planes.
  const double extra = reach * 4 + 10;
  const double s0 = m.at("sMin").get<double>() - extra;
  const double length = m.at("sMax").get<double>() - m.at("sMin").get<double>() + 2 * extra;
  const gp_Dir t(xyz(m.at("t"))), u(xyz(m.at("u"))), v(xyz(m.at("v")));
  const gp_Pnt o = gp_Pnt(xyz(m.at("a"))).Translated(gp_Vec(t) * s0 + gp_Vec(u) * ou + gp_Vec(v) * ov);
  BRepPrimAPI_MakePrism prism(sectionFace(m.at("section"), o, u, v, t), gp_Vec(t) * length, false, true);
  const double size = length * 2 + reach * 4;
  return trim(trim(prism.Shape(), m.at("start"), size), m.at("end"), size);
}

}  // namespace

FeatureOutput buildFrameMembers(const BuildContext& ctx) {
  const Json& prepared = ctx.feature().prepared;
  const auto members = prepared.find("members");
  if (members == prepared.end() || !members->is_array() || members->empty())
    throw FeatureError("Taille de profilé inconnue ou lignes de longueur nulle");
  std::vector<TopoDS_Shape> solids;
  Body tool;
  for (const Json& m : *members) {
    solids.push_back(memberSolid(m));
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(solids.back(), TopAbs_FACE, faces);
    const std::string key = m.value("key", std::to_string(solids.size()));
    for (int i = 1; i <= faces.Extent(); i++) tool.names.set(faces(i), ctx.name("member(" + key + "." + std::to_string(i) + ")"));
  }
  tool.shape = compoundOf(solids);
  // Distinct bodies: the compound takes over the previous body and the new profiles, without fusion.
  Body out;
  out.names = tool.names;
  if (const Body* prev = ctx.prev()) {
    out.shape = compoundOf({prev->shape, tool.shape});
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(prev->shape, TopAbs_FACE, faces);
    for (int i = 1; i <= faces.Extent(); i++)
      if (const std::string* n = prev->names.face(faces(i))) out.names.set(faces(i), *n);
  } else {
    out.shape = compoundOf({tool.shape});
  }
  out.tool = std::make_shared<const Tool>(Tool{tool.shape, tool.names, false});
  return out;
}

}  // namespace cad
