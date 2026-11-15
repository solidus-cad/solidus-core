// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Sketch: builds the faces (closed regions) and the wires (open chains) of a resolved sketch.
// The resolution of constraints (PlaneGCS) and the analysis of profiles are done by the client: the kernel receives
// the resolved geometry and the list of oriented loops (format in core/README.md).
// 3D sketch: the client sends its resolved points, its lines and splines (splines as poles) and its chains in
// `prepared.curves3d`; the kernel builds one wire per chain, used as sweep path, loft section or guide.
#include "part/features.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Tool.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_Curve.hxx>
#include <ShapeFix_Face.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <gp_Circ.hxx>

#include <algorithm>
#include <cmath>
#include <unordered_map>

namespace cad {

gp_Pnt SketchProfile::toWorld(const gp_Pnt2d& p) const {
  const gp_Pnt& o = frame.Location();
  const gp_Dir& x = frame.XDirection();
  const gp_Dir& y = frame.YDirection();
  return gp_Pnt(o.X() + p.X() * x.X() + p.Y() * y.X(), o.Y() + p.X() * x.Y() + p.Y() * y.Y(),
                o.Z() + p.X() * x.Z() + p.Y() * y.Z());
}

namespace {

gp_XYZ vec3(const Json& j) { return gp_XYZ(j.at(0).get<double>(), j.at(1).get<double>(), j.at(2).get<double>()); }

class SketchBuilder {
public:
  explicit SketchBuilder(const Json& s) : sketch_(s) {
    const Json& f = s.at("frame");
    const gp_Dir x(vec3(f.at("xDir")));
    const gp_Dir n(vec3(f.at("normal")));
    profile_.frame = gp_Ax3(gp_Pnt(vec3(f.at("origin"))), n, x);
    // Frame orientation depends on the plane (XZ: sketch Y = +Z): the Y axis sent by the client is enforced.
    if (f.contains("yDir")) {
      const gp_Dir y(vec3(f.at("yDir")));
      if (profile_.frame.YDirection().Dot(y) < 0) profile_.frame.YReverse();
    }
    for (const auto& [id, p] : s.at("points").items()) points_[id] = gp_Pnt2d(p.at(0).get<double>(), p.at(1).get<double>());
    for (const auto& [id, c] : s.at("curves").items()) {
      if (c.at("type") == "line") profile_.lines[id] = {point(c.at("p1")), point(c.at("p2"))};
    }
    auto pnt = [](const Json& p) { return gp_Pnt2d(p.at(0).get<double>(), p.at(1).get<double>()); };
    if (const auto it = s.find("isolated"); it != s.end())
      for (const Json& p : *it) profile_.isolated.push_back({p.at("id").get<std::string>(), pnt(p.at("p"))});
    if (const auto it = s.find("segments"); it != s.end())
      for (const Json& g : *it) profile_.segments.push_back({g.at("id").get<std::string>(), pnt(g.at("a")), pnt(g.at("b"))});
    if (const auto it = s.find("polyline"); it != s.end() && it->is_object()) {
      for (const Json& p : it->at("pts")) profile_.polyline.push_back(pnt(p));
      profile_.polylineLinesOnly = it->value("linesOnly", true);
    }
    if (const auto it = s.find("pathStart"); it != s.end() && it->is_object()) {
      const Json& t = it->at("t");
      profile_.pathStart = std::make_pair(pnt(it->at("p")), gp_Vec2d(t.at(0).get<double>(), t.at(1).get<double>()));
    }
  }

  SketchProfile build() {
    for (const Json& region : sketch_.at("regions")) {
      TopoDS_Wire outer = wire(region.at("outer"));
      BRepBuilderAPI_MakeFace mk(outer, true);
      for (const Json& h : region.at("holes")) mk.Add(wire(h));
      if (!mk.IsDone()) throw FeatureError("Impossible de créer la face du profil");
      ShapeFix_Face fix(mk.Face());
      fix.Perform();
      profile_.faces.push_back(fix.Face());
      profile_.regionKeys.push_back(regionKey(region.at("outer")));
    }
    for (const Json& chain : sketch_.at("chains")) profile_.wires.push_back(wire(Json{{"curves", chain}, {"reverse", false}}));
    mapEdges();
    return std::move(profile_);
  }

private:
  gp_Pnt2d point(const Json& id) const {
    auto it = points_.find(id.get<std::string>());
    if (it == points_.end()) throw FeatureError("Point d'esquisse introuvable");
    return it->second;
  }

  gp_Circ circle(const gp_Pnt2d& center, double r) const {
    return gp_Circ(gp_Ax2(profile_.toWorld(center), profile_.frame.Direction(), profile_.frame.XDirection()), r);
  }

  TopoDS_Edge edge(const Json& oriented) {
    const std::string id = oriented.at("id").get<std::string>();
    const Json& c = sketch_.at("curves").at(id);
    const std::string type = c.at("type").get<std::string>();
    BRepBuilderAPI_MakeEdge mk;
    if (type == "line") {
      const gp_Pnt a = profile_.toWorld(point(c.at("p1")));
      const gp_Pnt b = profile_.toWorld(point(c.at("p2")));
      if (a.Distance(b) < 1e-7) throw FeatureError("Segment de longueur nulle");
      mk = BRepBuilderAPI_MakeEdge(a, b);
    } else if (type == "circle") {
      mk = BRepBuilderAPI_MakeEdge(circle(point(c.at("c")), c.at("r").get<double>()));
    } else if (type == "arc") {
      const gp_Pnt2d center = point(c.at("c"));
      const gp_Pnt2d s = point(c.at("start"));
      const gp_Pnt2d e = point(c.at("end"));
      mk = BRepBuilderAPI_MakeEdge(circle(center, center.Distance(s)), profile_.toWorld(s), profile_.toWorld(e));
    } else if (type == "bspline") {
      mk = BRepBuilderAPI_MakeEdge(bspline(c));
    } else {
      throw FeatureError("Courbe d'esquisse inconnue « " + type + " »");
    }
    if (!mk.IsDone()) throw FeatureError("Courbe d'esquisse invalide");
    TopoDS_Edge out = mk.Edge();
    curveIds_[BRep_Tool::Curve(out, first_, last_).get()] = id;
    if (oriented.value("reversed", false)) out = TopoDS::Edge(out.Reversed());
    return out;
  }

  /// B-spline of the sketch (poles, knots and multiplicities as sent by the client), in the plane of the sketch.
  Handle(Geom_BSplineCurve) bspline(const Json& c) const {
    const Json& ids = c.at("poles");
    const Json& knots = c.at("knots");
    const Json& mults = c.at("mults");
    const int degree = c.at("degree").get<int>();
    const bool periodic = c.value("periodic", false);
    const int n = static_cast<int>(ids.size());
    if (degree < 1 || n < (periodic ? degree + 1 : 2) || knots.size() != mults.size() || knots.size() < 2)
      throw FeatureError("Spline d'esquisse invalide");
    TColgp_Array1OfPnt poles(1, n);
    TColStd_Array1OfReal weights(1, n);
    for (int i = 0; i < n; i++) {
      poles(i + 1) = profile_.toWorld(point(ids[i]));
      weights(i + 1) = c.contains("weights") ? c.at("weights").at(i).get<double>() : 1.0;
    }
    const int k = static_cast<int>(knots.size());
    TColStd_Array1OfReal kv(1, k);
    TColStd_Array1OfInteger mv(1, k);
    for (int i = 0; i < k; i++) {
      kv(i + 1) = knots[i].get<double>();
      mv(i + 1) = mults[i].get<int>();
    }
    try {
      return new Geom_BSplineCurve(poles, weights, kv, mv, degree, periodic);
    } catch (const Standard_Failure&) {
      throw FeatureError("Spline d'esquisse invalide");
    }
  }

  TopoDS_Wire wire(const Json& loop) {
    BRepBuilderAPI_MakeWire mk;
    for (const Json& c : loop.at("curves")) mk.Add(edge(c));
    if (!mk.IsDone()) throw FeatureError("Contour non connecté");
    TopoDS_Wire w = mk.Wire();
    if (loop.value("reverse", false)) w = TopoDS::Wire(w.Reversed());
    return w;
  }

  static std::string regionKey(const Json& loop) {
    std::string key;
    for (const Json& c : loop.at("curves")) {
      const std::string id = c.at("id").get<std::string>();
      if (key.empty() || id < key) key = id;
    }
    return key;
  }

  /// Final edges → sketch curve. MakeWire and ShapeFix may recreate the edges, but keep the 3D curve.
  void mapEdges() {
    auto visit = [&](const TopoDS_Shape& s) {
      for (TopExp_Explorer ex(s, TopAbs_EDGE); ex.More(); ex.Next()) {
        double f, l;
        Handle(Geom_Curve) c = BRep_Tool::Curve(TopoDS::Edge(ex.Current()), f, l);
        auto it = curveIds_.find(c.get());
        if (it != curveIds_.end()) profile_.edgeCurves[ex.Current()] = it->second;
      }
    };
    for (const TopoDS_Face& f : profile_.faces) visit(f);
    for (const TopoDS_Wire& w : profile_.wires) visit(w);
  }

  const Json& sketch_;
  SketchProfile profile_;
  std::unordered_map<std::string, gp_Pnt2d> points_;
  std::unordered_map<const Geom_Curve*, std::string> curveIds_;
  double first_ = 0, last_ = 0;
};

}  // namespace

namespace {

gp_Pnt pnt3(const Json& p) { return gp_Pnt(vec3(p)); }

/// Edge of a 3D sketch curve: line between two points, or B-spline given by its poles (part frame).
TopoDS_Edge spaceEdge(const Json& c, const std::unordered_map<std::string, gp_Pnt>& points) {
  auto point = [&](const Json& id) {
    const auto it = points.find(id.get<std::string>());
    if (it == points.end()) throw FeatureError("Point d'esquisse introuvable");
    return it->second;
  };
  const std::string type = c.at("type").get<std::string>();
  BRepBuilderAPI_MakeEdge mk;
  if (type == "line") {
    const gp_Pnt a = point(c.at("p1"));
    const gp_Pnt b = point(c.at("p2"));
    if (a.Distance(b) < 1e-7) throw FeatureError("Segment de longueur nulle");
    mk = BRepBuilderAPI_MakeEdge(a, b);
  } else if (type == "bspline") {
    const Json& poles = c.at("poles");
    const Json& knots = c.at("knots");
    const Json& mults = c.at("mults");
    const int degree = c.at("degree").get<int>();
    const int n = static_cast<int>(poles.size());
    if (degree < 1 || n < 2 || knots.size() != mults.size() || knots.size() < 2) throw FeatureError("Spline d'esquisse invalide");
    TColgp_Array1OfPnt pv(1, n);
    for (int i = 0; i < n; i++) pv(i + 1) = pnt3(poles[i]);
    const int k = static_cast<int>(knots.size());
    TColStd_Array1OfReal kv(1, k);
    TColStd_Array1OfInteger mv(1, k);
    for (int i = 0; i < k; i++) {
      kv(i + 1) = knots[i].get<double>();
      mv(i + 1) = mults[i].get<int>();
    }
    try {
      mk = BRepBuilderAPI_MakeEdge(Handle(Geom_BSplineCurve)(new Geom_BSplineCurve(pv, kv, mv, degree)));
    } catch (const Standard_Failure&) {
      throw FeatureError("Spline d'esquisse invalide");
    }
  } else {
    throw FeatureError("Courbe d'esquisse inconnue « " + type + " »");
  }
  if (!mk.IsDone()) throw FeatureError("Courbe d'esquisse invalide");
  return mk.Edge();
}

}  // namespace

FeatureOutput buildSketch3D(const BuildContext& ctx) {
  SketchProfile profile;
  profile.space = true;
  const Json& prepared = ctx.feature().prepared;
  const auto data = prepared.is_object() ? prepared.find("curves3d") : prepared.end();
  if (!prepared.is_object() || data == prepared.end()) return profile;
  std::unordered_map<std::string, gp_Pnt> points;
  for (const auto& [id, p] : data->at("points").items()) points[id] = pnt3(p);
  std::unordered_map<const Geom_Curve*, std::string> curveIds;
  for (const Json& chain : data->at("chains")) {
    BRepBuilderAPI_MakeWire mk;
    for (const Json& oriented : chain) {
      const std::string id = oriented.at("id").get<std::string>();
      TopoDS_Edge e = spaceEdge(data->at("curves").at(id), points);
      double first, last;
      curveIds[BRep_Tool::Curve(e, first, last).get()] = id;
      if (oriented.value("reversed", false)) e = TopoDS::Edge(e.Reversed());
      mk.Add(e);
    }
    if (!mk.IsDone()) throw FeatureError("Chaîne de l'esquisse 3D non connectée");
    profile.wires.push_back(mk.Wire());
  }
  for (const TopoDS_Wire& w : profile.wires)
    for (TopExp_Explorer ex(w, TopAbs_EDGE); ex.More(); ex.Next()) {
      double f, l;
      const auto it = curveIds.find(BRep_Tool::Curve(TopoDS::Edge(ex.Current()), f, l).get());
      if (it != curveIds.end()) profile.edgeCurves[ex.Current()] = it->second;
    }
  // Start of the first chain: first edge in the order of the wire, at its start (its orientation taken into account).
  if (!profile.wires.empty()) {
    BRepTools_WireExplorer ex(profile.wires.front());
    if (ex.More()) {
      const TopoDS_Edge& e = ex.Current();
      BRepAdaptor_Curve c(e);
      const bool reversed = e.Orientation() == TopAbs_REVERSED;
      gp_Pnt p;
      gp_Vec d;
      c.D1(reversed ? c.LastParameter() : c.FirstParameter(), p, d);
      if (d.Magnitude() > 1e-12) profile.spaceStart = std::make_pair(p, gp_Dir(reversed ? d.Reversed() : d));
    }
  }
  return profile;
}

FeatureOutput buildSketch(const BuildContext& ctx) {
  const Json& s = ctx.feature().sketch;
  if (s.is_null()) throw FeatureError("Esquisse vide");
  return SketchBuilder(s).build();
}

}  // namespace cad
