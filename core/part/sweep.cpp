// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Extrude, thin extrude and revolve of a sketch. Naming:
//   - side face from the sketch curve C: "<id>/side(C)";
//   - start and end faces of the region R: "<id>/start(R)", "<id>/end(R)" (R = smallest curve id of the outline);
//   - thin extrude of the chain K: side faces "<id>/thin(K.k)" (k = rank of the element in the thickened outline),
//     start and end faces "<id>/start(K)", "<id>/end(K)" (K = smallest curve id of the chain).
#include "part/features.hpp"

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepTools.hxx>
#include <GProp_GProps.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Geom_Curve.hxx>
#include <ShapeFix_Face.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <gp_Circ.hxx>

#include <cmath>
#include <functional>
#include <numbers>
#include <optional>
#include <unordered_map>

namespace cad {
namespace {

constexpr const char* kAxisH = "axis:H";  // SKETCH_AXIS_H of @solidus-cad/sdk
constexpr const char* kAxisV = "axis:V";  // SKETCH_AXIS_V

void requireFaces(const SketchProfile& s) {
  if (s.faces.empty()) throw FeatureError("L'esquisse ne contient aucun contour fermé");
}

TopoDS_Compound compound(const std::vector<TopoDS_Face>& faces) {
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  for (const TopoDS_Face& f : faces) b.Add(c, f);
  return c;
}

/// Names the faces of a sweep (prism or revolution) from the curves and regions of the sketch.
/// `edgeOf` gives, for an edge of the sketch, the edge actually swept (possibly a translated copy).
template <class Sweep, class EdgeOf, class FaceOf>
TopoNames sweepNames(const BuildContext& ctx, const SketchProfile& s, Sweep& mk, EdgeOf edgeOf, FaceOf faceOf) {
  TopoNames names;
  for (const TopoDS_Face& face : s.faces) {
    TopTools_IndexedMapOfShape edges;
    TopExp::MapShapes(face, TopAbs_EDGE, edges);
    for (int i = 1; i <= edges.Extent(); i++) {
      auto curve = s.edgeCurves.find(edges(i));
      if (curve == s.edgeCurves.end()) continue;
      for (const TopoDS_Shape& f : mk.Generated(edgeOf(edges(i))))
        if (f.ShapeType() == TopAbs_FACE) names.set(f, ctx.name("side(" + curve->second + ")"));
    }
  }
  for (size_t i = 0; i < s.faces.size(); i++) {
    const TopoDS_Shape base = faceOf(s.faces[i]);
    const TopoDS_Shape first = mk.FirstShape(base);
    const TopoDS_Shape last = mk.LastShape(base);
    if (!first.IsNull()) names.set(first, ctx.name("start(" + s.regionKeys[i] + ")"));
    if (!last.IsNull()) names.set(last, ctx.name("end(" + s.regionKeys[i] + ")"));
  }
  return names;
}

using ShapeMap = std::function<TopoDS_Shape(const TopoDS_Shape&)>;
/// Names the faces of a prism; `mapped` gives the swept shape that corresponds to a shape of the profile.
using PrismNamer = std::function<TopoNames(BRepPrimAPI_MakePrism&, const ShapeMap& mapped)>;

/// Prism of a profile normal to the sketch plane, according to the chosen limit (length, symmetric, through all).
Body prismTool(const BuildContext& ctx, const SketchProfile& s, const TopoDS_Shape& profile, const PrismNamer& namer) {
  const std::string mode = ctx.str("mode");
  const double sign = ctx.str("reverse") == "yes" ? -1 : 1;
  // "Through all": long enough to cross the whole body, wherever the sketch plane is.
  const double depth =
      mode == "throughAll" ? (std::max(bodyReach(ctx.prev(), s.frame.Location()), 1.0) + 1) * 2 : ctx.positive("depth");
  const bool both = mode == "symmetric" || (mode == "throughAll" && ctx.str("op") == "cut");
  const gp_Dir n = s.frame.Direction();

  TopoDS_Shape base = profile;
  std::optional<BRepBuilderAPI_Transform> moved;
  if (both) {
    gp_Trsf t;
    t.SetTranslation(gp_Vec(n) * (-sign * depth / 2));
    moved.emplace(profile, t, true, false);
    base = moved->Shape();
  }
  const ShapeMap mapped = [&](const TopoDS_Shape& sh) { return moved ? moved->ModifiedShape(sh) : sh; };

  BRepPrimAPI_MakePrism mk(base, gp_Vec(n) * (sign * depth), false, true);
  if (!mk.IsDone()) throw FeatureError("L'extrusion a échoué");
  Body tool;
  tool.shape = mk.Shape();
  tool.names = namer(mk, mapped);
  return tool;
}

gp_Pnt2d pt(const Json& p) { return gp_Pnt2d(p.at("x").get<double>(), p.at("y").get<double>()); }

/// Planar face bounded by a thickened outline (ThinPrim of @solidus-cad/sketch, in the sketch frame).
/// `curves` receives, for each element of the outline, the 3D curve of the created edge (nullptr if the element is ignored).
TopoDS_Face outlineFace(const SketchProfile& s, const Json& outline, std::vector<const Geom_Curve*>& curves) {
  BRepBuilderAPI_MakeWire mkWire;
  for (const Json& e : outline) {
    const bool arc = e.at("type") == "arc";
    gp_Pnt2d a = pt(e.at("a"));
    gp_Pnt2d b = pt(e.at("b"));
    if (!arc && a.Distance(b) < 1e-7) {
      curves.push_back(nullptr);
      continue;
    }
    if (arc && !e.value("ccw", true)) std::swap(a, b);
    BRepBuilderAPI_MakeEdge mk;
    if (arc) {
      const gp_Circ circ(gp_Ax2(s.toWorld(pt(e.at("c"))), s.frame.Direction(), s.frame.XDirection()), e.at("r").get<double>());
      mk = BRepBuilderAPI_MakeEdge(circ, s.toWorld(a), s.toWorld(b));
    } else {
      mk = BRepBuilderAPI_MakeEdge(s.toWorld(a), s.toWorld(b));
    }
    if (!mk.IsDone()) throw FeatureError("Paroi mince invalide");
    double first, last;
    curves.push_back(BRep_Tool::Curve(mk.Edge(), first, last).get());
    mkWire.Add(mk.Edge());
  }
  if (!mkWire.IsDone()) throw FeatureError("Contour de la paroi mince non connecté");
  BRepBuilderAPI_MakeFace mkFace(mkWire.Wire(), true);
  if (!mkFace.IsDone()) throw FeatureError("Impossible de créer la face de la paroi mince");
  ShapeFix_Face fix(mkFace.Face());
  fix.Perform();
  const TopoDS_Face face = fix.Face();
  if (!BRepCheck_Analyzer(face, true).IsValid())
    throw FeatureError("La paroi mince se recoupe (épaisseur trop grande par rapport au profil ?)");
  return face;
}

/// Maximum angular step between two successive sections of a twist extrude.
constexpr double kTwistStep = std::numbers::pi / 24;

struct TwistParams {
  int sections;
  double start, sign, depth, twist;
};

/// Lofted solid (ThruSections) passing through copies of the wire rotated around the normal of the sketch.
/// Side faces "<id>/side(C)"; start and end faces "<id>/start(R)", "<id>/end(R)" if `regionKey` is given.
Body twistLoft(const BuildContext& ctx, const SketchProfile& s, const TopoDS_Wire& wire, const TwistParams& p, const std::string* regionKey) {
  const gp_Ax1 axis(s.frame.Location(), s.frame.Direction());
  BRepOffsetAPI_ThruSections th(true, false, 1e-6);
  th.CheckCompatibility(false);
  std::optional<BRepBuilderAPI_Transform> first;
  for (int k = 0; k <= p.sections; k++) {
    const double t = double(k) / p.sections;
    gp_Trsf rot;
    rot.SetRotation(axis, p.twist * t);
    gp_Trsf tr;
    tr.SetTranslation(gp_Vec(s.frame.Direction()) * (p.start + p.sign * p.depth * t));
    tr.Multiply(rot);
    if (k == 0) {
      first.emplace(wire, tr, true, false);
      th.AddWire(TopoDS::Wire(first->Shape()));
    } else {
      BRepBuilderAPI_Transform moved(wire, tr, true, false);
      th.AddWire(TopoDS::Wire(moved.Shape()));
    }
  }
  th.Build();
  if (!th.IsDone()) throw FeatureError("L'extrusion torsadée a échoué (torsion trop forte pour ce profil ?)");
  Body out;
  out.shape = th.Shape();
  GProp_GProps props;
  BRepGProp::VolumeProperties(out.shape, props);
  if (props.Mass() < 0) out.shape.Reverse();

  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes(wire, TopAbs_EDGE, edges);
  for (int i = 1; i <= edges.Extent(); i++) {
    auto curve = s.edgeCurves.find(edges(i));
    if (curve == s.edgeCurves.end()) continue;
    for (const TopoDS_Shape& f : th.Generated(first->ModifiedShape(edges(i))))
      if (f.ShapeType() == TopAbs_FACE) out.names.set(f, ctx.name("side(" + curve->second + ")"));
  }
  if (regionKey) {
    if (!th.FirstShape().IsNull()) out.names.set(th.FirstShape(), ctx.name("start(" + *regionKey + ")"));
    if (!th.LastShape().IsNull()) out.names.set(th.LastShape(), ctx.name("end(" + *regionKey + ")"));
  }
  return out;
}

}  // namespace

/// Twist extrude: each region is lofted between rotated sections (outer outline), its holes are removed.
FeatureOutput buildTwistExtrude(const BuildContext& ctx) {
  const SketchProfile& s = ctx.sketch("sketch");
  requireFaces(s);
  const double twist = ctx.num("twist") * std::numbers::pi / 180;
  if (std::abs(twist) > 4 * std::numbers::pi) throw FeatureError("La torsion est limitée à ±720°");
  const double depth = ctx.positive("depth");
  const double sign = ctx.str("reverse") == "yes" ? -1 : 1;
  const TwistParams p{std::max(1, int(std::ceil(std::abs(twist) / kTwistStep))), ctx.str("mode") == "symmetric" ? -sign * depth / 2 : 0, sign, depth, twist};

  TopoDS_Compound all;
  BRep_Builder builder;
  builder.MakeCompound(all);
  TopoNames names;
  for (size_t i = 0; i < s.faces.size(); i++) {
    const TopoDS_Wire outerWire = BRepTools::OuterWire(s.faces[i]);
    Body region = twistLoft(ctx, s, outerWire, p, &s.regionKeys[i]);
    std::vector<Body> holes;
    for (TopExp_Explorer ex(s.faces[i], TopAbs_WIRE); ex.More(); ex.Next())
      if (!ex.Current().IsSame(outerWire)) holes.push_back(twistLoft(ctx, s, TopoDS::Wire(ex.Current()), p, nullptr));
    if (!holes.empty()) {
      std::vector<const Body*> parts{&region};
      for (const Body& h : holes) parts.push_back(&h);
      region = booleanNamed(ctx, parts, true, "twist");
    }
    builder.Add(all, region.shape);
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(region.shape, TopAbs_FACE, faces);
    for (int f = 1; f <= faces.Extent(); f++)
      if (const std::string* name = region.names.face(faces(f))) names.set(faces(f), *name);
  }
  Body tool;
  tool.shape = all;
  tool.names = std::move(names);
  return combine(ctx, std::move(tool));
}

FeatureOutput buildExtrude(const BuildContext& ctx) {
  const SketchProfile& s = ctx.sketch("sketch");
  requireFaces(s);
  Body tool = prismTool(ctx, s, compound(s.faces), [&](BRepPrimAPI_MakePrism& mk, const ShapeMap& mapped) {
    return sweepNames(ctx, s, mk, mapped, mapped);
  });
  return combine(ctx, std::move(tool));
}

/// Thin extrude: open chains thickened on one side, the other, or centred, then extruded normal to the plane.
/// The thickened outlines are computed by the client (`thinOutline` of @solidus-cad/sketch, see core/CONCEPTION.md) and received in
/// `prepared.outlines` = [{ key, prims }]; `prepared.error` reports a thickness incompatible with the profile.
FeatureOutput buildThinExtrude(const BuildContext& ctx) {
  const SketchProfile& s = ctx.sketch("sketch");
  if (s.wires.empty()) throw FeatureError("L'esquisse ne contient aucun profil ouvert : utilisez l'extrusion");
  ctx.positive("thickness");
  const Json& prepared = ctx.feature().prepared;
  if (const auto it = prepared.find("error"); it != prepared.end()) throw FeatureError(it->get<std::string>());
  const auto outlines = prepared.find("outlines");
  if (outlines == prepared.end() || !outlines->is_array()) throw FeatureError("Contour de la paroi mince non préparé");

  struct Wall {
    std::string key;
    TopoDS_Face face;
    std::unordered_map<const Geom_Curve*, size_t> curves;  // 3D curve → rank in the outline
  };
  std::vector<Wall> walls;
  std::vector<TopoDS_Face> faces;
  for (const Json& o : *outlines) {
    Wall w;
    w.key = o.at("key").get<std::string>();
    std::vector<const Geom_Curve*> curves;
    w.face = outlineFace(s, o.at("prims"), curves);
    for (size_t k = 0; k < curves.size(); k++)
      if (curves[k]) w.curves[curves[k]] = k;
    faces.push_back(w.face);
    walls.push_back(std::move(w));
  }

  Body tool = prismTool(ctx, s, compound(faces), [&](BRepPrimAPI_MakePrism& mk, const ShapeMap& mapped) {
    TopoNames names;
    for (const Wall& w : walls) {
      // ShapeFix may recreate the edges, but keeps their 3D curve.
      for (TopExp_Explorer ex(w.face, TopAbs_EDGE); ex.More(); ex.Next()) {
        double first, last;
        const auto k = w.curves.find(BRep_Tool::Curve(TopoDS::Edge(ex.Current()), first, last).get());
        if (k == w.curves.end()) continue;
        for (const TopoDS_Shape& f : mk.Generated(mapped(ex.Current())))
          if (f.ShapeType() == TopAbs_FACE) names.set(f, ctx.name("thin(" + w.key + "." + std::to_string(k->second) + ")"));
      }
      const TopoDS_Shape base = mapped(w.face);
      const TopoDS_Shape first = mk.FirstShape(base);
      const TopoDS_Shape last = mk.LastShape(base);
      if (!first.IsNull()) names.set(first, ctx.name("start(" + w.key + ")"));
      if (!last.IsNull()) names.set(last, ctx.name("end(" + w.key + ")"));
    }
    return names;
  });
  return combine(ctx, std::move(tool));
}

gp_Ax1 revolveAxis(const BuildContext& ctx, const SketchProfile& s) {
  const std::string axisId = ctx.str("axis");
  gp_Pnt2d a, b;
  if (axisId == kAxisH || axisId == kAxisV) {
    a = gp_Pnt2d(0, 0);
    b = axisId == kAxisH ? gp_Pnt2d(1, 0) : gp_Pnt2d(0, 1);
  } else {
    auto it = s.lines.find(axisId);
    if (it == s.lines.end()) throw FeatureError("Axe de révolution introuvable");
    a = it->second.first;
    b = it->second.second;
  }
  const gp_Pnt pa = s.toWorld(a);
  const gp_Pnt pb = s.toWorld(b);
  if (pa.Distance(pb) < 1e-12) throw FeatureError("Axe de révolution de longueur nulle");
  return gp_Ax1(pa, gp_Dir(gp_Vec(pa, pb)));
}

FeatureOutput buildRevolve(const BuildContext& ctx) {
  const SketchProfile& s = ctx.sketch("sketch");
  const double angle = ctx.num("angle");
  if (angle <= 0 || angle > 360) throw FeatureError("L'angle doit être compris entre 0 et 360°");
  const gp_Ax1 ax = revolveAxis(ctx, s);
  requireFaces(s);
  const TopoDS_Compound profile = compound(s.faces);
  BRepPrimAPI_MakeRevol mk(profile, ax, angle * std::numbers::pi / 180, false);
  if (!mk.IsDone()) throw FeatureError("La révolution a échoué (le profil coupe-t-il l'axe ?)");
  Body tool;
  tool.shape = mk.Shape();
  auto same = [](const TopoDS_Shape& sh) { return sh; };
  tool.names = sweepNames(ctx, s, mk, same, same);
  return combine(ctx, std::move(tool));
}

}  // namespace cad
