// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "analysis/surface.hpp"

#include <BRepAdaptor_Surface.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>

#include <cmath>
#include <limits>
#include <numbers>
#include <stdexcept>

namespace cad {

CurvatureKind curvatureKind(std::string_view name) {
  if (name == "gaussian") return CurvatureKind::Gaussian;
  if (name == "mean") return CurvatureKind::Mean;
  if (name == "min") return CurvatureKind::Min;
  if (name == "max") return CurvatureKind::Max;
  throw std::invalid_argument("Analyse de courbure inconnue");
}

std::vector<float> curvatureAtNodes(const TopoDS_Shape& shape, CurvatureKind kind) {
  std::vector<float> out;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++) {
    const TopoDS_Face& face = TopoDS::Face(faces(i));
    TopLoc_Location loc;
    const Handle(Poly_Triangulation)& tri = BRep_Tool::Triangulation(face, loc);
    // Same rule as meshFaces: a face without triangles has no vertex in the mesh.
    if (tri.IsNull() || tri->NbTriangles() == 0) continue;
    const bool reversed = face.Orientation() == TopAbs_REVERSED;
    BRepAdaptor_Surface surface(face);
    BRepLProp_SLProps props(surface, 2, 1e-7);
    for (int n = 1; n <= tri->NbNodes(); n++) {
      float value = std::numeric_limits<float>::quiet_NaN();
      if (tri->HasUVNodes()) {
        const gp_Pnt2d uv = tri->UVNode(n);
        props.SetParameters(uv.X(), uv.Y());
        if (props.IsCurvatureDefined()) {
          // The surface normal is reversed on a reversed face: mean and principal curvatures change sign.
          const double s = reversed ? -1 : 1;
          const double k1 = s * props.MinCurvature(), k2 = s * props.MaxCurvature();
          switch (kind) {
            case CurvatureKind::Gaussian: value = float(props.GaussianCurvature()); break;
            case CurvatureKind::Mean: value = float(s * props.MeanCurvature()); break;
            case CurvatureKind::Min: value = float(std::min(k1, k2)); break;
            case CurvatureKind::Max: value = float(std::max(k1, k2)); break;
          }
        }
      }
      out.push_back(value);
    }
  }
  return out;
}

namespace {

/// Point, oriented normal, and normal curvature in the direction `across` of a face at (u, v).
struct Local {
  gp_Pnt p;
  gp_Vec n;
  bool ok = false;
};

Local localAt(const TopoDS_Face& face, BRepLProp_SLProps& props, const gp_Pnt2d& uv) {
  props.SetParameters(uv.X(), uv.Y());
  Local l;
  l.p = props.Value();
  if (!props.IsNormalDefined()) return l;
  l.n = gp_Vec(props.Normal());
  if (face.Orientation() == TopAbs_REVERSED) l.n.Reverse();
  l.ok = true;
  return l;
}

/// Normal curvature of the face in the tangent direction `d`, with the oriented normal.
double normalCurvature(const TopoDS_Face& face, BRepLProp_SLProps& props, const gp_Vec& d) {
  if (!props.IsCurvatureDefined()) return 0;
  const double s = face.Orientation() == TopAbs_REVERSED ? -1 : 1;
  if (props.IsUmbilic()) return s * props.MeanCurvature();
  gp_Dir dMax, dMin;
  props.CurvatureDirections(dMax, dMin);
  const double c = d.Normalized().Dot(gp_Vec(dMax));
  return s * (props.MaxCurvature() * c * c + props.MinCurvature() * (1 - c * c));
}

}  // namespace

std::vector<ContinuitySample> edgeContinuity(const TopoDS_Shape& shape, const TopoDS_Edge& edge, int samples) {
  TopTools_IndexedDataMapOfShapeListOfShape owners;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  const TopTools_ListOfShape* faces = owners.Seek(edge);
  if (!faces || faces->Extent() != 2) throw std::runtime_error("L'arête ne sépare pas deux faces");
  const TopoDS_Face f1 = TopoDS::Face(faces->First());
  const TopoDS_Face f2 = TopoDS::Face(faces->Last());
  if (f1.IsSame(f2)) throw std::runtime_error("Arête de couture : une seule face de part et d'autre");
  double a1, b1, a2, b2;
  const Handle(Geom2d_Curve) c1 = BRep_Tool::CurveOnSurface(edge, f1, a1, b1);
  const Handle(Geom2d_Curve) c2 = BRep_Tool::CurveOnSurface(edge, f2, a2, b2);
  if (c1.IsNull() || c2.IsNull()) throw std::runtime_error("Courbe de l'arête sur ses faces introuvable");
  BRepAdaptor_Surface s1(f1), s2(f2);
  BRepLProp_SLProps p1(s1, 2, 1e-7), p2(s2, 2, 1e-7);
  std::vector<ContinuitySample> out;
  for (int k = 1; k <= samples; k++) {
    const double t = double(k) / (samples + 1);
    const Local l1 = localAt(f1, p1, c1->Value(a1 + (b1 - a1) * t));
    const Local l2 = localAt(f2, p2, c2->Value(a2 + (b2 - a2) * t));
    if (!l1.ok || !l2.ok) continue;
    ContinuitySample s;
    s.p = l1.p;
    s.g0 = l1.p.Distance(l2.p);
    s.g1 = l1.n.Angle(l2.n) * 180 / std::numbers::pi;
    // Direction across the edge, in the tangent plane of the first face.
    gp_Vec tangent;
    gp_Pnt2d uv;
    gp_Vec2d d2;
    c1->D1(a1 + (b1 - a1) * t, uv, d2);
    tangent = gp_Vec(p1.D1U()) * d2.X() + gp_Vec(p1.D1V()) * d2.Y();
    const gp_Vec across = l1.n.Crossed(tangent);
    s.g2 = across.Magnitude() < 1e-12 ? 0 : std::abs(normalCurvature(f1, p1, across) - normalCurvature(f2, p2, across));
    out.push_back(s);
  }
  return out;
}

}  // namespace cad
