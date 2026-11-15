// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Plugin features: interpretation of geometric recipes (format and semantics defined in
// packages/sdk/src/geometry.ts). The recipe arrives validated by the client
// (validateRecipe) in `prepared.recipe`; it is read again here defensively (JSON accesses checked).
#include "part/features.hpp"

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepTools.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Trsf.hxx>

#include <cmath>

namespace cad {
namespace {

constexpr int kMaxDepth = 64;

struct Plane {
  gp_Pnt o;
  gp_Dir x, y, n;
};

double num(const Json& j, const char* key) {
  if (!j.contains(key) || !j[key].is_number()) throw FeatureError(std::string("Recette : « ") + key + " » attendu");
  const double v = j[key].get<double>();
  if (!std::isfinite(v)) throw FeatureError(std::string("Recette : « ") + key + " » invalide");
  return v;
}

gp_XYZ vec3(const Json& j, const char* key, gp_XYZ fallback) {
  if (!j.contains(key)) return fallback;
  const Json& a = j[key];
  if (!a.is_array() || a.size() != 3) throw FeatureError(std::string("Recette : « ") + key + " » : [x, y, z] attendu");
  return {a[0].get<double>(), a[1].get<double>(), a[2].get<double>()};
}

gp_Dir dir3(const Json& j, const char* key, gp_XYZ fallback) {
  const gp_XYZ v = vec3(j, key, fallback);
  if (v.Modulus() < 1e-12) throw FeatureError(std::string("Recette : « ") + key + " » : direction nulle");
  return gp_Dir(v);
}

Plane planeOf(const Json& s) {
  if (!s.contains("plane") || s["plane"].is_null() || s["plane"] == "XY") return {gp_Pnt(0, 0, 0), gp::DX(), gp::DY(), gp::DZ()};
  const Json& p = s["plane"];
  if (p == "XZ") return {gp_Pnt(0, 0, 0), gp::DX(), gp::DZ(), gp_Dir(0, -1, 0)};
  if (p == "YZ") return {gp_Pnt(0, 0, 0), gp::DY(), gp::DZ(), gp::DX()};
  if (!p.is_object()) throw FeatureError("Recette : plan inconnu");
  const gp_Dir n = dir3(p, "normal", {0, 0, 1});
  gp_XYZ xr = vec3(p, "xDir", {1, 0, 0});
  xr -= n.XYZ() * xr.Dot(n.XYZ());
  if (xr.Modulus() < 1e-9) throw FeatureError("Plan de recette : xDir parallèle à la normale");
  const gp_Dir x(xr);
  return {gp_Pnt(vec3(p, "origin", {0, 0, 0})), x, n.Crossed(x), n};
}

gp_Pnt to3(const Plane& f, double u, double v) { return gp_Pnt(f.o.XYZ() + f.x.XYZ() * u + f.y.XYZ() * v); }

TopoDS_Face loopFace(const Plane& f, const Json& loop) {
  TopoDS_Wire wire;
  const std::string kind = loop.value("kind", "");
  if (kind == "circle") {
    const Json& c = loop.at("center");
    const gp_Ax2 ax(to3(f, c.at(0).get<double>(), c.at(1).get<double>()), f.n, f.x);
    wire = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Circ(ax, num(loop, "r")))).Wire();
  } else if (kind == "polygon") {
    const Json& pts = loop.at("points");
    std::vector<gp_Pnt> p;
    for (size_t i = 0; i < pts.size(); i++) {
      const gp_Pnt a = to3(f, pts[i].at(0).get<double>(), pts[i].at(1).get<double>());
      const gp_Pnt b = to3(f, pts[(i + 1) % pts.size()].at(0).get<double>(), pts[(i + 1) % pts.size()].at(1).get<double>());
      if (a.Distance(b) > 1e-7) p.push_back(a);
    }
    if (p.size() < 3) throw FeatureError("Polygone de recette dégénéré");
    BRepBuilderAPI_MakeWire mk;
    for (size_t i = 0; i < p.size(); i++) mk.Add(BRepBuilderAPI_MakeEdge(p[i], p[(i + 1) % p.size()]).Edge());
    if (!mk.IsDone()) throw FeatureError("Contour de recette invalide (polygone non fermé ou croisé)");
    wire = mk.Wire();
  } else
    throw FeatureError("Recette : contour inconnu");
  BRepBuilderAPI_MakeFace face(wire, true);
  if (!face.IsDone()) throw FeatureError("Contour de recette non plan ou invalide");
  return face.Face();
}

TopoDS_Shape boolean(int op, const TopoDS_Shape& a, const TopoDS_Shape& b) {
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> algo;
  if (op == 0)
    algo = std::make_unique<BRepAlgoAPI_Fuse>();
  else if (op == 1)
    algo = std::make_unique<BRepAlgoAPI_Cut>();
  else
    algo = std::make_unique<BRepAlgoAPI_Common>();
  TopTools_ListOfShape args, tools;
  args.Append(a);
  tools.Append(b);
  algo->SetArguments(args);
  algo->SetTools(tools);
  algo->Build();
  if (!algo->IsDone() || algo->HasErrors()) throw FeatureError("Opération booléenne de la recette impossible");
  return algo->Shape();
}

TopoDS_Shape transformed(const TopoDS_Shape& s, const gp_Trsf& t) { return BRepBuilderAPI_Transform(s, t, true).Shape(); }

class Evaluator {
public:
  explicit Evaluator(const Body* body) : body_(body) {}

  TopoDS_Shape eval(const Json& s, int depth = 0) {
    if (depth > kMaxDepth) throw FeatureError("Recette : imbrication trop profonde");
    if (!s.is_object()) throw FeatureError("Recette : solide attendu");
    const std::string op = s.value("op", "");
    if (op == "body") {
      if (!body_) throw FeatureError("La recette utilise le corps, mais la pièce n'en a pas encore");
      return body_->shape;
    }
    if (op == "box") {
      const gp_XYZ size = vec3(s, "size", {0, 0, 0});
      if (size.X() <= 0 || size.Y() <= 0 || size.Z() <= 0) throw FeatureError("Recette : dimensions de boîte positives attendues");
      return BRepPrimAPI_MakeBox(gp_Pnt(vec3(s, "at", {0, 0, 0})), size.X(), size.Y(), size.Z()).Shape();
    }
    if (op == "cylinder") {
      const gp_Ax2 ax(gp_Pnt(vec3(s, "at", {0, 0, 0})), dir3(s, "dir", {0, 0, 1}));
      return BRepPrimAPI_MakeCylinder(ax, num(s, "r"), num(s, "h")).Shape();
    }
    if (op == "cone") {
      // Trapezoid (r, z) revolved around the axis: same construction as the TypeScript kernel.
      const gp_Dir dir = dir3(s, "dir", {0, 0, 1});
      const gp_XYZ ref = std::abs(dir.X()) < 0.9 ? gp_XYZ(1, 0, 0) : gp_XYZ(0, 1, 0);
      const gp_Dir radial(dir.XYZ().Crossed(ref).Crossed(dir.XYZ()));
      const double r1 = num(s, "r1"), r2 = num(s, "r2"), h = num(s, "h");
      Json pts = Json::array({Json::array({0, 0})});
      if (r1 > 0) pts.push_back(Json::array({r1, 0}));
      if (r2 > 0) pts.push_back(Json::array({r2, h}));
      pts.push_back(Json::array({0, h}));
      const gp_XYZ at = vec3(s, "at", {0, 0, 0});
      const gp_XYZ n = radial.XYZ().Crossed(dir.XYZ());
      Json rev = {{"op", "revolve"},
                  {"angle", 360},
                  {"plane", {{"origin", {at.X(), at.Y(), at.Z()}}, {"normal", {n.X(), n.Y(), n.Z()}}, {"xDir", {radial.X(), radial.Y(), radial.Z()}}}},
                  {"profile", {{"outer", {{"kind", "polygon"}, {"points", pts}}}}}};
      return eval(rev, depth + 1);
    }
    if (op == "sphere") return BRepPrimAPI_MakeSphere(gp_Pnt(vec3(s, "at", {0, 0, 0})), num(s, "r")).Shape();
    if (op == "extrude") {
      Plane f = planeOf(s);
      const double h = num(s, "h");
      if (s.value("symmetric", false)) f.o.Translate(gp_Vec(f.n) * (-h / 2));
      const gp_Vec v = gp_Vec(f.n) * h;
      return profileSolid(s.at("profile"), f, [&](const TopoDS_Face& face) {
        BRepPrimAPI_MakePrism mk(face, v, false, true);
        if (!mk.IsDone()) throw FeatureError("Extrusion de la recette impossible");
        return mk.Shape();
      });
    }
    if (op == "twistExtrude") {
      const Plane f = planeOf(s);
      const double h = num(s, "h");
      const double twist = num(s, "twist") * M_PI / 180;
      const double start = s.value("symmetric", false) ? -h / 2 : 0;
      const int n = std::max(1, int(std::ceil(std::abs(twist) / (M_PI / 24))));
      const gp_Ax1 axis(f.o, f.n);
      return profileSolid(s.at("profile"), f, [&](const TopoDS_Face& face) {
        const TopoDS_Wire outer = BRepTools::OuterWire(face);
        BRepOffsetAPI_ThruSections th(true, false, 1e-6);
        th.CheckCompatibility(false);
        for (int k = 0; k <= n; k++) {
          const double t = double(k) / n;
          gp_Trsf rot;
          rot.SetRotation(axis, twist * t);
          gp_Trsf tr;
          tr.SetTranslation(gp_Vec(f.n) * (start + h * t));
          tr.Multiply(rot);
          th.AddWire(TopoDS::Wire(BRepBuilderAPI_Transform(outer, tr, true, false).Shape()));
        }
        th.Build();
        if (!th.IsDone()) throw FeatureError("Extrusion torsadée de la recette impossible");
        return th.Shape();
      });
    }
    if (op == "revolve") {
      const Plane f = planeOf(s);
      const double angle = num(s, "angle") * M_PI / 180;
      return profileSolid(s.at("profile"), f, [&](const TopoDS_Face& face) {
        BRepPrimAPI_MakeRevol mk(face, gp_Ax1(f.o, f.y), angle, false);
        if (!mk.IsDone()) throw FeatureError("Révolution de la recette impossible (profil traversant l'axe ?)");
        return mk.Shape();
      });
    }
    if (op == "union" || op == "intersect") return fold(s.at("solids"), op == "union" ? 0 : 2, depth);
    if (op == "cut") {
      TopoDS_Shape acc = eval(s.at("from"), depth + 1);
      for (const Json& t : s.at("tools")) acc = boolean(1, acc, eval(t, depth + 1));
      return acc;
    }
    if (op == "translate") {
      gp_Trsf t;
      t.SetTranslation(gp_Vec(vec3(s, "by", {0, 0, 0})));
      return transformed(eval(s.at("solid"), depth + 1), t);
    }
    if (op == "rotate") {
      gp_Trsf t;
      t.SetRotation(gp_Ax1(gp_Pnt(vec3(s, "origin", {0, 0, 0})), dir3(s, "axis", {0, 0, 1})), num(s, "angle") * M_PI / 180);
      return transformed(eval(s.at("solid"), depth + 1), t);
    }
    if (op == "fillet" || op == "chamfer") {
      const TopoDS_Shape inner = eval(s.at("solid"), depth + 1);
      TopTools_IndexedMapOfShape edges;
      TopExp::MapShapes(inner, TopAbs_EDGE, edges);
      if (op == "fillet") {
        BRepFilletAPI_MakeFillet mk(inner);
        for (int i = 1; i <= edges.Extent(); i++) mk.Add(num(s, "r"), TopoDS::Edge(edges(i)));
        mk.Build();
        if (!mk.IsDone()) throw FeatureError("Congé de la recette impossible");
        return mk.Shape();
      }
      BRepFilletAPI_MakeChamfer mk(inner);
      for (int i = 1; i <= edges.Extent(); i++) mk.Add(num(s, "d"), TopoDS::Edge(edges(i)));
      mk.Build();
      if (!mk.IsDone()) throw FeatureError("Chanfrein de la recette impossible");
      return mk.Shape();
    }
    throw FeatureError("Recette : opération inconnue « " + op + " »");
  }

private:
  template <class Sweep>
  TopoDS_Shape profileSolid(const Json& profile, const Plane& f, Sweep sweep) {
    TopoDS_Shape acc = sweep(loopFace(f, profile.at("outer")));
    if (profile.contains("holes"))
      for (const Json& h : profile["holes"]) acc = boolean(1, acc, sweep(loopFace(f, h)));
    return acc;
  }

  TopoDS_Shape fold(const Json& solids, int op, int depth) {
    if (!solids.is_array() || solids.empty()) throw FeatureError("Recette : liste de solides vide");
    TopoDS_Shape acc = eval(solids[0], depth + 1);
    for (size_t i = 1; i < solids.size(); i++) acc = boolean(op, acc, eval(solids[i], depth + 1));
    return acc;
  }

  const Body* body_;
};

}  // namespace

FeatureOutput buildPluginRecipe(const BuildContext& ctx) {
  const Json& p = ctx.feature().prepared;
  if (!p.is_object()) throw FeatureError("Fonction de plugin sans données");
  const std::string plugin = p.value("plugin", "");
  if (p.contains("error") && p["error"].is_string()) throw FeatureError(plugin + " : " + p["error"].get<std::string>());
  if (!p.contains("recipe") || !p["recipe"].is_object()) throw FeatureError("Plugin « " + plugin + " » absent et aucune forme enregistrée");
  const Json& recipe = p["recipe"];
  try {
    Body tool;
    tool.shape = Evaluator(ctx.prev()).eval(recipe.at("solid"));
    // Topology depends on the parameters: faces named by rank (as for elementary parts).
    nameByRank(ctx, tool.names, tool.shape, "plugin");
    const std::string mode = recipe.value("mode", "add");
    if (mode == "replace") return tool;
    if (mode != "add" && mode != "cut") throw FeatureError("Recette : mode « " + mode + " » inconnu");
    return combine(ctx, std::move(tool), mode == "cut");
  } catch (const Json::exception& e) {
    throw FeatureError(std::string("Recette invalide : ") + e.what());
  } catch (const Standard_Failure& e) {
    throw FeatureError(std::string("Recette : échec OCCT (") + (e.GetMessageString() ? e.GetMessageString() : "?") + ")");
  }
}

}  // namespace cad
