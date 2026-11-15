// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "analysis/projection.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepPrimAPI_MakeHalfSpace.hxx>
#include <HLRAlgo_Projector.hxx>
#include <HLRBRep_Algo.hxx>
#include <HLRBRep_HLRToShape.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Ax3.hxx>
#include <gp_Pln.hxx>

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace cad {
namespace {

/// Direction toward the observer (N) and horizontal view axis (Vx).
constexpr std::array<std::pair<const char*, std::array<double, 6>>, 7> kViews{{
    {"front", {0, -1, 0, 1, 0, 0}},
    {"back", {0, 1, 0, -1, 0, 0}},
    {"top", {0, 0, 1, 1, 0, 0}},
    {"bottom", {0, 0, -1, 1, 0, 0}},
    {"right", {1, 0, 0, 0, 1, 0}},
    {"left", {-1, 0, 0, 0, -1, 0}},
    {"iso", {1, -1, 1, 1, 1, 0}},
}};

/// Samples the edges of a compound: line = 2 points, circle = angular step of 0.1 rad, others = 64 points.
void discretize(const TopoDS_Shape& compound, std::vector<float>& segs, std::vector<float>* circles) {
  if (compound.IsNull()) return;
  for (TopExp_Explorer ex(compound, TopAbs_EDGE); ex.More(); ex.Next()) {
    const BRepAdaptor_Curve ad(TopoDS::Edge(ex.Current()));
    const GeomAbs_CurveType type = ad.GetType();
    if (circles && type == GeomAbs_Circle) {
      const gp_Circ c = ad.Circle();
      circles->insert(circles->end(), {float(c.Location().X()), float(c.Location().Y()), float(c.Radius())});
    }
    const double u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    const int count = type == GeomAbs_Line ? 1 : type == GeomAbs_Circle ? std::max(8, int(std::ceil(std::abs(u1 - u0) / 0.1))) : 64;
    gp_Pnt prev;
    for (int i = 0; i <= count; i++) {
      const gp_Pnt p = ad.Value(u0 + (u1 - u0) * i / count);
      if (i > 0) segs.insert(segs.end(), {float(prev.X()), float(prev.Y()), float(p.X()), float(p.Y())});
      prev = p;
    }
  }
}

}  // namespace

ViewAxes viewAxes(std::string_view kind) {
  for (const auto& [name, v] : kViews) {
    if (kind != name) continue;
    const gp_Dir n(v[0], v[1], v[2]);
    const gp_Dir x(v[3], v[4], v[5]);
    return {n, x, n.Crossed(x)};
  }
  throw std::runtime_error("Vue inconnue « " + std::string(kind) + " »");
}

ProjectedView projectShape(const TopoDS_Shape& shape, std::string_view kind) {
  const ViewAxes axes = viewAxes(kind);
  Handle(HLRBRep_Algo) algo = new HLRBRep_Algo();
  algo->Add(shape, 0);
  algo->Projector(HLRAlgo_Projector(gp_Ax2(gp::Origin(), axes.n, axes.x)));
  algo->Update();
  algo->Hide();
  HLRBRep_HLRToShape toShape(algo);
  ProjectedView out;
  discretize(toShape.VCompound(), out.visible, &out.circles);
  discretize(toShape.OutLineVCompound(), out.visible, &out.circles);
  discretize(toShape.HCompound(), out.hidden, nullptr);
  discretize(toShape.OutLineHCompound(), out.hidden, nullptr);
  double x0 = std::numeric_limits<double>::infinity(), y0 = x0, x1 = -x0, y1 = -x0;
  for (size_t i = 0; i + 1 < out.visible.size(); i += 2) {
    x0 = std::min(x0, double(out.visible[i]));
    x1 = std::max(x1, double(out.visible[i]));
    y0 = std::min(y0, double(out.visible[i + 1]));
    y1 = std::max(y1, double(out.visible[i + 1]));
  }
  if (!std::isfinite(x0)) x0 = y0 = x1 = y1 = 0;
  out.bounds = {x0, y0, x1, y1};
  return out;
}

Section sectionShape(const TopoDS_Shape& shape, std::string_view kind, double depth, double size) {
  const ViewAxes v = viewAxes(kind);
  const gp_Pnt o(v.n.XYZ() * depth);
  // Finite face plane, large enough to cover the shape.
  const double L = std::max(size, 1.0) * 4;
  const TopoDS_Face face = BRepBuilderAPI_MakeFace(gp_Pln(gp_Ax3(o, v.n, v.x)), -L, L, -L, L).Face();
  const BRepPrimAPI_MakeHalfSpace half(face, gp_Pnt(v.n.XYZ() * (depth + L)));
  Section out;
  out.kept = BRepAlgoAPI_Cut(shape, half.Solid()).Shape();
  // Section outlines: intersection of the solid and the plane.
  const TopoDS_Shape common = BRepAlgoAPI_Common(shape, face).Shape();
  for (TopExp_Explorer ex(common, TopAbs_EDGE); ex.More(); ex.Next()) {
    const BRepAdaptor_Curve ad(TopoDS::Edge(ex.Current()));
    const double u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    const int count = ad.GetType() == GeomAbs_Line ? 1 : 48;
    float px = 0, py = 0;
    for (int i = 0; i <= count; i++) {
      const gp_XYZ q = ad.Value(u0 + (u1 - u0) * i / count).XYZ();
      const float cx = float(q.Dot(v.x.XYZ())), cy = float(q.Dot(v.y.XYZ()));
      if (i > 0) out.segments.insert(out.segments.end(), {px, py, cx, cy});
      px = cx;
      py = cy;
    }
  }
  return out;
}

}  // namespace cad
