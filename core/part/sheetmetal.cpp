// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Sheet metal workbench: base sheet (closed outline or open profile), edge flanges, cuts, sketched bend, flattening.
// Model described in core/part/sheet.hpp.
// Naming (provisional, see core/NAMING.md): rebuilt sheet bodies are named by rank, "<id>/sheet(k)";
// the cut (sheetCut) goes through combine() and keeps the names.
#include "analysis/projection.hpp"
#include "part/features.hpp"
#include "part/sheet.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Iterator.hxx>

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <optional>

namespace cad {
namespace {

using V = gp_XYZ;
using Rigid = gp_Trsf;
using Poly2 = std::vector<std::pair<double, double>>;
constexpr double kPi = std::numbers::pi;

/// Opposite of a vector (gp_XYZ has no unary minus).
V operator-(const V& a) { return a.Reversed(); }

V unit(const V& a) {
  const double l = a.Modulus();
  return l > 0 ? a / l : a;
}
V apply(const Rigid& m, V p) {
  m.Transforms(p);
  return p;
}
V applyDir(const Rigid& m, const V& d) { return gp_Vec(d).Transformed(m).XYZ(); }
Rigid compose(const Rigid& a, const Rigid& b) { return a.Multiplied(b); }  // a ∘ b
Rigid translation(const V& v) {
  Rigid t;
  t.SetTranslation(gp_Vec(v));
  return t;
}
/// Rotation of angle `a` around the axis (c, u).
Rigid rotation(const V& c, const V& u, double a) {
  Rigid t;
  t.SetRotation(gp_Ax1(gp_Pnt(c), gp_Dir(u)), a);
  return t;
}
/// Frame (axes u, w, n, origin o) → world.
Rigid frameOf(const V& u, const V& w, const V& n, const V& o) {
  Rigid t;
  t.SetValues(u.X(), w.X(), n.X(), o.X(), u.Y(), w.Y(), n.Y(), o.Y(), u.Z(), w.Z(), n.Z(), o.Z());
  return t;
}

TopoDS_Shape moved(const TopoDS_Shape& shape, const Rigid& m) { return BRepBuilderAPI_Transform(shape, m, true, false).Shape(); }

/// Planar face of a 3D polygon.
TopoDS_Face polygonFace(const std::vector<V>& pts) {
  BRepBuilderAPI_MakeWire mk;
  for (size_t i = 0; i < pts.size(); i++) mk.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(pts[i]), gp_Pnt(pts[(i + 1) % pts.size()])).Edge());
  return BRepBuilderAPI_MakeFace(mk.Wire(), true).Face();
}

TopoDS_Shape prism(const TopoDS_Shape& face, const V& d) { return BRepPrimAPI_MakePrism(face, gp_Vec(d), false, true).Shape(); }

/// Parallelepiped with origin `o` and edges a, b, c.
TopoDS_Shape slab(const V& o, const V& a, const V& b, const V& c) { return prism(polygonFace({o, o + a, o + a + b, o + b}), c); }

enum class Op { Fuse, Cut, Common };

TopoDS_Shape boolean(Op op, const TopoDS_Shape& a, const TopoDS_Shape& b) {
  TopoDS_Shape r;
  bool done = false;
  if (op == Op::Fuse) {
    BRepAlgoAPI_Fuse algo(a, b);
    done = algo.IsDone();
    if (done) r = algo.Shape();
  } else if (op == Op::Cut) {
    BRepAlgoAPI_Cut algo(a, b);
    done = algo.IsDone();
    if (done) r = algo.Shape();
  } else {
    BRepAlgoAPI_Common algo(a, b);
    done = algo.IsDone();
    if (done) r = algo.Shape();
  }
  if (!done) throw FeatureError("Opération booléenne de tôlerie impossible");
  ShapeUpgrade_UnifySameDomain unify(r, true, true, false);
  unify.Build();
  return unify.Shape();
}

/// Fusion of adjoining pieces.
TopoDS_Shape fuseAll(const std::vector<TopoDS_Shape>& shapes) {
  if (shapes.empty()) throw FeatureError("Aucune géométrie de tôle");
  TopoDS_Shape acc = shapes.front();
  for (size_t i = 1; i < shapes.size(); i++) acc = boolean(Op::Fuse, acc, shapes[i]);
  return acc;
}

double volume(const TopoDS_Shape& s) {
  GProp_GProps g;
  BRepGProp::VolumeProperties(s, g, false, false, false);
  return g.Mass();
}

double distanceTo(const V& p, const TopoDS_Shape& s) {
  BRepExtrema_DistShapeShape d(BRepBuilderAPI_MakeVertex(gp_Pnt(p)).Vertex(), s);
  return d.IsDone() ? d.Value() : std::numeric_limits<double>::infinity();
}

/// True if a small cube (half-side `h`, axes u, w, n) centred at `c` lies in the material: non-zero common volume.
bool insideBody(const TopoDS_Shape& body, const V& c, double h, const V& u, const V& w, const V& n) {
  const TopoDS_Shape cube = slab(c - u * h - w * h - n * h, u * (2 * h), w * (2 * h), n * (2 * h));
  BRepAlgoAPI_Common common(body, cube);
  return common.IsDone() && volume(common.Shape()) > 4 * h * h * h;
}

double area2(const Poly2& pts) {
  double a = 0;
  for (size_t i = 0; i < pts.size(); i++) {
    const auto& [x1, y1] = pts[i];
    const auto& [x2, y2] = pts[(i + 1) % pts.size()];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/// Chains polylines (in any order and direction) into closed loops.
std::vector<Poly2> chainLoops(std::vector<Poly2> left, double tol) {
  auto same = [&](const std::pair<double, double>& p, const std::pair<double, double>& q) {
    return std::hypot(p.first - q.first, p.second - q.second) < tol;
  };
  std::erase_if(left, [](const Poly2& p) { return p.size() < 2; });
  std::vector<Poly2> loops;
  while (!left.empty()) {
    Poly2 loop = left.front();
    left.erase(left.begin());
    for (;;) {
      const auto end = loop.back();
      if (loop.size() > 2 && same(end, loop.front())) break;
      auto it = std::find_if(left.begin(), left.end(), [&](const Poly2& p) { return same(p.front(), end) || same(p.back(), end); });
      if (it == left.end()) break;
      Poly2 next = *it;
      left.erase(it);
      if (!same(next.front(), end)) std::reverse(next.begin(), next.end());
      loop.insert(loop.end(), next.begin() + 1, next.end());
    }
    if (same(loop.back(), loop.front())) loop.pop_back();
    loops.push_back(std::move(loop));
  }
  return loops;
}

/// Planar face of an outer outline and holes (coplanar 3D polygons); orientation of the holes corrected by ShapeFix.
TopoDS_Face polygonFaceWithHoles(const std::vector<V>& outer, const std::vector<std::vector<V>>& holes) {
  auto wire = [](const std::vector<V>& pts) {
    BRepBuilderAPI_MakeWire mk;
    for (size_t i = 0; i < pts.size(); i++) {
      const gp_Pnt a(pts[i]), b(pts[(i + 1) % pts.size()]);
      if (a.Distance(b) > 1e-9) mk.Add(BRepBuilderAPI_MakeEdge(a, b).Edge());
    }
    return mk.Wire();
  };
  BRepBuilderAPI_MakeFace mk(wire(outer), true);
  for (const auto& h : holes) mk.Add(wire(h));
  ShapeFix_Face fix(mk.Face());
  fix.Perform();
  return fix.Face();
}

/// Geometry of a bend: centre, signed angle and zone description.
struct BendGeo {
  V center;
  double alpha;
  ZoneGeo geo;
};

BendGeo zoneGeo(const SheetState& s, const V& q, const V& u, double len, const V& w, const V& n, double angle, bool up,
                const Rigid& parent) {
  const double T = s.thickness, R = s.radius, K = s.k;
  const double sgn = u.Crossed(w).Dot(n) > 0 ? 1 : -1;
  const V center = up ? q + n * R : q - n * (T + R);
  const double alpha = (up ? 1 : -1) * sgn * angle;
  ZoneGeo g;
  g.c = center;
  g.axis = alpha >= 0 ? u : -u;
  g.r0 = unit(q - center);
  g.q = q;
  g.u = u;
  g.w = w;
  g.n = n;
  g.len = len;
  g.angle = angle;
  g.neutral = R + K * T;
  // Neutral fibre: at K·T from the inner face (face of q if the bend rises, opposite face otherwise).
  g.depth = up ? K * T : T - K * T;
  g.toFlat = parent.Inverted();
  return {center, alpha, g};
}

/// Geometry of a zone after a rigid motion `m` of the folded part.
ZoneGeo movedGeo(const ZoneGeo& g, const Rigid& m) {
  ZoneGeo out = g;
  out.c = apply(m, g.c);
  out.q = apply(m, g.q);
  out.axis = applyDir(m, g.axis);
  out.r0 = applyDir(m, g.r0);
  out.u = applyDir(m, g.u);
  out.w = applyDir(m, g.w);
  out.n = applyDir(m, g.n);
  out.toFlat = compose(g.toFlat, m.Inverted());
  return out;
}

/// Bent sector: revolution of the end section of the plate.
TopoDS_Shape bendSector(const V& q, const V& u, double len, const V& n, double T, const V& center, double alpha) {
  const TopoDS_Face section = polygonFace({q, q + u * len, q + u * len - n * T, q - n * T});
  return BRepPrimAPI_MakeRevol(section, gp_Ax1(gp_Pnt(center), gp_Dir(alpha >= 0 ? u : -u)), std::abs(alpha), false).Shape();
}

/**
 * Cut of a bent zone brought back into the flat pattern: the part of the neutral fibre (cylinder of radius R + K·T)
 * inside the tool is unrolled (abscissa = angle × neutral radius, position along the axis kept), then extruded
 * through the whole thickness, limited to the flat band of the bend.
 */
std::optional<TopoDS_Shape> unrolledCut(const SheetState& s, const ZoneGeo& g, const TopoDS_Shape& tool) {
  const double T = s.thickness;
  const V p0 = g.c + g.r0 * g.neutral;
  const TopoDS_Edge edge = BRepBuilderAPI_MakeEdge(gp_Pnt(p0), gp_Pnt(p0 + g.u * g.len)).Edge();
  const TopoDS_Shape neutral = BRepPrimAPI_MakeRevol(edge, gp_Ax1(gp_Pnt(g.c), gp_Dir(g.axis)), g.angle, false).Shape();
  const TopoDS_Shape inside = BRepAlgoAPI_Common(neutral, tool).Shape();
  // Point on the neutral cylinder → (position along the edge, unrolled length).
  auto unroll = [&](const V& x) {
    const V v = x - g.c;
    const double along = v.Dot(g.u) - (g.q - g.c).Dot(g.u);
    const double axial = v.Dot(g.axis);
    const V radial = v - g.axis * axial;
    double phi = std::atan2(g.r0.Crossed(radial).Dot(g.axis), g.r0.Dot(radial));
    if (phi < -1e-9) phi += 2 * kPi;
    return std::make_pair(along, phi * g.neutral);
  };
  std::vector<std::vector<Poly2>> loopsOfFaces;
  for (TopExp_Explorer fx(inside, TopAbs_FACE); fx.More(); fx.Next()) {
    std::vector<Poly2> polylines;
    for (TopExp_Explorer ex(fx.Current(), TopAbs_EDGE); ex.More(); ex.Next()) {
      const BRepAdaptor_Curve ad(TopoDS::Edge(ex.Current()));
      const double u0 = ad.FirstParameter(), u1 = ad.LastParameter();
      const int count = ad.GetType() == GeomAbs_Line ? 1 : 32;
      Poly2 pts;
      for (int i = 0; i <= count; i++) pts.push_back(unroll(ad.Value(u0 + (u1 - u0) * i / count).XYZ()));
      polylines.push_back(std::move(pts));
    }
    loopsOfFaces.push_back(chainLoops(std::move(polylines), std::max(T * 1e-3, 1e-5)));
  }
  // Planar faces in the "unfolded" folded frame (extension of the original plate), then flat pattern.
  const double eps = std::max(T * 0.01, 1e-3);
  auto to3 = [&](const std::pair<double, double>& p) { return apply(g.toFlat, g.q + g.u * p.first + g.w * p.second + g.n * eps); };
  const V thick = applyDir(g.toFlat, g.n * -(T + 2 * eps));
  std::vector<TopoDS_Shape> prisms;
  for (std::vector<Poly2>& loops : loopsOfFaces) {
    std::erase_if(loops, [](const Poly2& l) { return l.size() < 3 || std::abs(area2(l)) <= 1e-9; });
    if (loops.empty()) continue;
    std::sort(loops.begin(), loops.end(), [](const Poly2& a, const Poly2& b) { return std::abs(area2(a)) > std::abs(area2(b)); });
    auto map3 = [&](const Poly2& l) {
      std::vector<V> out;
      for (const auto& p : l) out.push_back(to3(p));
      return out;
    };
    std::vector<std::vector<V>> holes;
    for (size_t i = 1; i < loops.size(); i++) holes.push_back(map3(loops[i]));
    prisms.push_back(prism(polygonFaceWithHoles(map3(loops[0]), holes), thick));
  }
  if (prisms.empty()) return std::nullopt;
  return fuseAll(prisms);
}

/**
 * Removes `tool` (folded frame) from the plates: each removed part is brought back into the flat pattern by the
 * inverse transform of its plate. The bent zones are only cut in the folded state, then carried over unrolled into
 * the flat pattern.
 */
void cutSheet(SheetState& s, const TopoDS_Shape& tool) {
  for (SheetState::Plate& p : s.plates) {
    const TopoDS_Shape common = boolean(Op::Common, moved(p.flat, p.fold), tool);
    if (volume(common) <= 1e-9) continue;
    const TopoDS_Shape back = moved(common, p.fold.Inverted());
    s.flat = boolean(Op::Cut, s.flat, back);
    p.flat = boolean(Op::Cut, p.flat, back);
  }
  for (SheetState::Zone& z : s.zones) {
    if (volume(boolean(Op::Common, z.folded, tool)) <= 1e-9) continue;
    z.folded = boolean(Op::Cut, z.folded, tool);
    const std::optional<TopoDS_Shape> flatTool = unrolledCut(s, z.geo, tool);
    if (!flatTool) continue;
    s.flat = boolean(Op::Cut, s.flat, *flatTool);
    z.flat = boolean(Op::Cut, z.flat, *flatTool);
  }
}

/// Folded body rebuilt from the plates and the bent zones.
TopoDS_Shape foldedBody(const SheetState& s) {
  std::vector<TopoDS_Shape> parts;
  for (const auto& p : s.plates) parts.push_back(moved(p.flat, p.fold));
  for (const auto& z : s.zones) parts.push_back(z.folded);
  return fuseAll(parts);
}

/// Extent of a shape along the axes (u, w, n) of a frame of origin `o`.
std::optional<std::pair<V, V>> extentIn(const TopoDS_Shape& shape, const V& o, const V& u, const V& w, const V& n) {
  Bnd_Box box;
  BRepBndLib::Add(moved(shape, frameOf(u, w, n, o).Inverted()), box, false);
  if (box.IsVoid()) return std::nullopt;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  return std::make_pair(V(x0, y0, z0), V(x1, y1, z1));
}

V centroid(const TopoDS_Shape& shape) {
  GProp_GProps g;
  BRepGProp::VolumeProperties(shape, g, false, false, false);
  return g.CentreOfMass().XYZ();
}

TopoDS_Shape cylinder(const V& base, const V& axis, double r, double h) {
  return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(base), gp_Dir(axis)), r, h).Shape();
}

struct Params {
  double thickness, radius, k;
};

Params sheetParams(const BuildContext& ctx) {
  const double k = ctx.num("kFactor");
  if (k < 0 || k > 1) throw FeatureError("Le facteur K doit être compris entre 0 et 1");
  const double radius = ctx.num("radius");
  if (radius < 0) throw FeatureError("Le rayon de pliage ne peut pas être négatif");
  return {ctx.positive("thickness"), radius, k};
}

/// Edge of a plate: origin `q` on the face with normal `n`, direction `u` (length `len`), `w` outward.
struct EdgeFrame {
  V q, u;
  double len;
  V w, n;
};

struct BendResult {
  TopoDS_Shape foldedBend;
  std::optional<TopoDS_Shape> foldedPlate;
  TopoDS_Shape flatBend;
  std::optional<TopoDS_Shape> flatPlate;
  Rigid fold;
  ZoneGeo geo;
};

/**
 * Bend from an edge of a plate. "up": the bend turns toward `n` (the face carrying the edge is inside the bend).
 * `ext`: extension of the plate (not of the bend) before the start and after the end of the edge (corner closure).
 */
BendResult bendFrom(SheetState& s, const Rigid& parent, const EdgeFrame& e, double angle, bool up, double length,
                    std::pair<double, double> ext = {0, 0}) {
  const double T = s.thickness, R = s.radius, K = s.k;
  const double BA = angle * (R + K * T);
  const BendGeo bg = zoneGeo(s, e.q, e.u, e.len, e.w, e.n, angle, up, parent);
  BendResult r;
  r.foldedBend = bendSector(e.q, e.u, e.len, e.n, T, bg.center, bg.alpha);
  const Rigid toFlat = parent.Inverted();
  const V thick = e.n * -T;
  r.flatBend = moved(slab(e.q, e.u * e.len, e.w * BA, thick), toFlat);
  r.fold = compose(rotation(bg.center, e.u, bg.alpha), compose(translation(e.w * -BA), parent));
  if (length > 1e-6) {
    if (e.len + ext.first + ext.second <= 1e-6) throw FeatureError("Fermeture de coin : bord trop court");
    const TopoDS_Shape plate = slab(e.q + e.w * BA - e.u * ext.first, e.u * (e.len + ext.first + ext.second), e.w * length, thick);
    r.flatPlate = moved(plate, toFlat);
    r.foldedPlate = moved(*r.flatPlate, r.fold);
  }
  r.geo = bg.geo;
  // Bend line: middle of the flat bend. Direction seen from above the flat pattern (frame normal).
  const V a = apply(toFlat, e.q + e.w * (BA / 2));
  const V b = apply(toFlat, e.q + e.u * e.len + e.w * (BA / 2));
  const V nFlat = applyDir(toFlat, e.n);
  s.bends.push_back({a, b, angle * 180 / kPi, nFlat.Dot(s.n) > 0 ? up : !up});
  return r;
}

/// Adds a bend and the plate that follows it to the body and to the flat pattern.
void addBend(SheetState& s, const BendResult& r, std::vector<TopoDS_Shape>& folded) {
  folded.push_back(r.foldedBend);
  if (r.foldedPlate) folded.push_back(*r.foldedPlate);
  // Piece-by-piece fusion: a compound of adjoining solids is not a valid boolean argument.
  s.flat = r.flatPlate ? fuseAll({s.flat, r.flatBend, *r.flatPlate}) : fuseAll({s.flat, r.flatBend});
  s.zones.push_back({r.flatBend, r.foldedBend, r.geo});
  if (r.flatPlate) s.plates.push_back({*r.flatPlate, r.fold});
}

/// Adds an elementary piece (bend, plate), its faces named by rank under the role `role`.
void addPiece(const BuildContext& ctx, std::vector<Body>& parts, const TopoDS_Shape& shape, const std::string& role) {
  Body b;
  b.shape = shape;
  nameByRank(ctx, b.names, shape, role);
  parts.push_back(std::move(b));
}

/// Faces left without a name (unexpected case): named by rank, so that the whole body is named.
void nameMissing(const BuildContext& ctx, Body& body, const std::string& role) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(body.shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++)
    if (!body.names.face(faces(i))) body.names.set(faces(i), ctx.name(role + "(" + std::to_string(i) + ")"));
}

/// Sheet body rebuilt from the state (sketched bend, flattening): named by rank, with the sheet state.
Body sheetBody(const BuildContext& ctx, const TopoDS_Shape& shape, SheetState s, std::shared_ptr<const Tool> tool = nullptr) {
  Body out;
  out.shape = shape;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++) out.names.set(faces(i), ctx.name("sheet(" + std::to_string(i) + ")"));
  out.sheet = std::make_shared<const SheetState>(std::move(s));
  out.tool = std::move(tool);
  return out;
}

}  // namespace

/// Base sheet: closed outline extruded by the thickness, or open profile bent and extruded.
FeatureOutput buildSheetBase(const BuildContext& ctx) {
  if (ctx.sheet()) throw FeatureError("La pièce a déjà une tôle de base (une seule tôle par pièce)");
  const Params params = sheetParams(ctx);
  const double T = params.thickness;
  const SketchProfile& sk = ctx.sketch("sketch");
  const bool reverse = ctx.str("reverse") == "yes";
  const V origin = sk.frame.Location().XYZ();
  const V n = sk.frame.Direction().XYZ();
  SheetState s;
  s.thickness = T;
  s.radius = params.radius;
  s.k = params.k;

  if (!sk.faces.empty()) {
    // Flat sheet: the outline (with its holes) extruded by the thickness.
    const V dir = n * (reverse ? -T : T);
    std::vector<TopoDS_Shape> faces(sk.faces.begin(), sk.faces.end());
    BRepPrimAPI_MakePrism mk(compoundOf(faces), gp_Vec(dir), false, true);
    Body tool;
    tool.shape = mk.Shape();
    // As for an extrusion: side face from the curve C "side(C)", faces of the region R "bottom(R)", "top(R)".
    for (size_t i = 0; i < sk.faces.size(); i++) {
      for (TopExp_Explorer ex(sk.faces[i], TopAbs_EDGE); ex.More(); ex.Next()) {
        const auto curve = sk.edgeCurves.find(ex.Current());
        if (curve == sk.edgeCurves.end()) continue;
        for (const TopoDS_Shape& f : mk.Generated(ex.Current()))
          if (f.ShapeType() == TopAbs_FACE) tool.names.set(f, ctx.name("side(" + curve->second + ")"));
      }
      const TopoDS_Shape bottom = mk.FirstShape(sk.faces[i]);
      const TopoDS_Shape top = mk.LastShape(sk.faces[i]);
      if (!bottom.IsNull()) tool.names.set(bottom, ctx.name("bottom(" + sk.regionKeys[i] + ")"));
      if (!top.IsNull()) tool.names.set(top, ctx.name("top(" + sk.regionKeys[i] + ")"));
    }
    nameMissing(ctx, tool, "sheet");
    s.origin = origin;
    s.x = sk.frame.XDirection().XYZ();
    s.y = sk.frame.YDirection().XYZ();
    s.n = n;
    s.mid = origin + dir * 0.5;
    s.plates.push_back({tool.shape, Rigid()});
    s.flat = tool.shape;
    Body out = combine(ctx, std::move(tool), false);
    out.sheet = std::make_shared<const SheetState>(std::move(s));
    return out;
  }

  // Sheet from profile: the polyline is a face of the sheet; the thickness is on one side, the depth along
  // the normal of the sketch.
  if (sk.polyline.empty())
    throw FeatureError("Esquisse vide : dessinez un contour fermé (tôle plane) ou une ligne brisée ouverte (tôle selon profil)");
  if (!sk.polylineLinesOnly)
    throw FeatureError("Tôle selon profil : seules les lignes sont prises en charge (les plis sont créés aux angles)");
  std::vector<V> pts;
  for (const gp_Pnt2d& p : sk.polyline) pts.push_back(sk.toWorld(p).XYZ());
  const double depth = ctx.positive("depth");
  const V u = n;
  // Symmetric extrusion: the depth is split on both sides of the sketch plane.
  if (ctx.str("depthMode") == "symmetric")
    for (V& p : pts) p -= u * (depth / 2);
  std::vector<V> dirs;
  std::vector<double> lens;
  for (size_t i = 1; i < pts.size(); i++) {
    dirs.push_back(unit(pts[i] - pts[i - 1]));
    lens.push_back((pts[i] - pts[i - 1]).Modulus());
  }
  auto side = [&](const V& d) { return unit(u.Crossed(d)) * (reverse ? -1 : 1); };  // side of the material
  struct Turn {
    double angle;
    bool up;
    double setback;
  };
  std::vector<Turn> turns;
  for (size_t i = 1; i < dirs.size(); i++) {
    const V& prev = dirs[i - 1];
    const V& d = dirs[i];
    const double angle = std::acos(std::clamp(prev.Dot(d), -1.0, 1.0));
    if (angle < 1e-6) throw FeatureError("Deux segments consécutifs sont alignés : fusionnez-les");
    if (angle > kPi - 1e-3) throw FeatureError("Pli à 180° impossible");
    const V nOut = -side(prev);
    const bool up = d.Dot(nOut) > 0;
    turns.push_back({angle, up, (up ? params.radius : params.radius + T) * std::tan(angle / 2)});
  }
  const V s0 = side(dirs[0]);
  const V x = dirs[0];
  s.origin = pts[0];
  s.x = x;
  s.y = s0.Crossed(x);
  s.n = s0;
  s.mid = pts[0] + s0 * (T / 2);
  auto straight = [&](size_t i) {
    return lens[i] - (i > 0 ? turns[i - 1].setback : 0) - (i < turns.size() ? turns[i].setback : 0);
  };
  for (size_t i = 0; i < lens.size(); i++)
    if (straight(i) < -1e-6) throw FeatureError("Segment " + std::to_string(i + 1) + " trop court pour les rayons de pliage");
  const TopoDS_Shape first = slab(pts[0], u * depth, x * straight(0), s0 * T);
  s.flat = first;
  s.plates.push_back({first, Rigid()});
  std::vector<TopoDS_Shape> folded{first};
  // Pieces named by rank along the profile: plate i "plate(i).k", bend i "bend(i).k".
  std::vector<Body> parts(1);
  parts[0].shape = first;
  nameByRank(ctx, parts[0].names, first, "plate(0)");
  Rigid parent;
  for (size_t i = 1; i + 1 < pts.size(); i++) {
    const Turn& t = turns[i - 1];
    const V& d = dirs[i - 1];
    const BendResult r = bendFrom(s, parent, {pts[i] - d * t.setback, u, depth, d, -side(d)}, t.angle, t.up, std::max(straight(i), 0.0));
    parent = r.fold;
    addBend(s, r, folded);
    addPiece(ctx, parts, r.foldedBend, "bend(" + std::to_string(i) + ")");
    if (r.foldedPlate) addPiece(ctx, parts, *r.foldedPlate, "plate(" + std::to_string(i) + ")");
  }
  std::vector<const Body*> ptrs;
  for (const Body& b : parts) ptrs.push_back(&b);
  Body tool = booleanNamed(ctx, ptrs, false, "sheet");
  nameMissing(ctx, tool, "sheet");
  Body out = combine(ctx, std::move(tool), false);
  out.sheet = std::make_shared<const SheetState>(std::move(s));
  return out;
}

/// Edge flange on one or more straight edges of the top or bottom of the sheet.
FeatureOutput buildEdgeFlange(const BuildContext& ctx) {
  const Body* prev = ctx.prev();
  if (!ctx.sheet() || !prev) throw FeatureError("Créez d'abord une tôle de base");
  if (ctx.sheet()->flattened) throw FeatureError("La tôle est mise à plat : placez le bord tombé avant la mise à plat");
  if (!hasRefs(ctx, TopAbs_EDGE)) throw FeatureError("Désignez au moins une arête de la tôle");
  const double length = ctx.positive("length");
  const double deg = ctx.num("angle");
  if (deg <= 0 || deg >= 180) throw FeatureError("L'angle doit être compris entre 0 et 180° (exclus)");
  const double angle = deg * kPi / 180;
  const bool up = ctx.str("direction") != "opposite";
  const double T = ctx.sheet()->thickness;
  const double R = ctx.sheet()->radius;
  // Position of the bend relative to the edge: bend outside (the sheet is not shortened), material inside
  // (outer face of the flange in line with the edge) or outside (inner face in line with the edge).
  std::string position = ctx.str("position");
  if (position.empty()) position = "bendOutside";
  const double setback = position == "materialInside" ? R + T : position == "materialOutside" ? R : 0;
  const double offStart = ctx.str("offsetStart").empty() ? 0 : ctx.num("offsetStart");
  const double offEnd = ctx.str("offsetEnd").empty() ? 0 : ctx.num("offsetEnd");
  if (offStart < 0 || offEnd < 0) throw FeatureError("Les retraits ne peuvent pas être négatifs");
  std::string relief = ctx.str("relief");
  if (relief.empty()) relief = "rect";
  std::string corner = ctx.str("corner");
  if (corner.empty()) corner = "open";
  if (corner != "open" && std::abs(deg - 90) > 1e-6) throw FeatureError("Fermeture de coin : seulement pour des bords à 90°");
  const double tol = std::max(refTolerance(prev), T * 0.02);
  const std::vector<TopoDS_Shape> edges = resolveRefs(ctx, *prev, TopAbs_EDGE);
  SheetState s = *ctx.sheet();
  std::vector<TopoDS_Shape> folded;
  // Named body: the removals and the addition of the flanges go through booleans with history (names kept).
  Body body = *prev;
  body.tool = nullptr;
  body.sheet = nullptr;
  // Flange pieces named by the designated edge (topological name in the previous body): "bend(A).k", "flange(A).k".
  std::vector<Body> parts;
  TopTools_IndexedMapOfShape prevEdges;
  TopExp::MapShapes(prev->shape, TopAbs_EDGE, prevEdges);
  const std::vector<std::string> prevEdgeNames = prev->names.edgeNames(prev->shape);
  auto edgeKey = [&](size_t k) {
    const int i = prevEdges.FindIndex(edges[k]);
    return i > 0 && size_t(i) <= prevEdgeNames.size() ? prevEdgeNames[size_t(i) - 1] : "e" + std::to_string(k);
  };

  // End points of the edges, to locate the corners (two designated edges that touch).
  std::vector<std::array<V, 2>> ends;
  for (const TopoDS_Shape& edge : edges) {
    const BRepAdaptor_Curve ad(TopoDS::Edge(edge));
    ends.push_back({ad.Value(ad.FirstParameter()).XYZ(), ad.Value(ad.LastParameter()).XYZ()});
  }
  // Extension of each plate at its ends: overlap (the first edge covers the second) or butt
  // (each up to the mid-thickness of the other).
  std::vector<std::array<double, 2>> ext(edges.size(), {0, 0});
  if (corner != "open") {
    for (size_t i = 0; i < edges.size(); i++)
      for (size_t j = i + 1; j < edges.size(); j++)
        for (int ei = 0; ei < 2; ei++)
          for (int ej = 0; ej < 2; ej++) {
            if ((ends[i][ei] - ends[j][ej]).Modulus() >= tol) continue;
            ext[i][ei] = corner == "overlap" ? R + T - setback : R + T / 2 - setback;
            ext[j][ej] = corner == "overlap" ? R - setback : R + T / 2 - setback;
          }
  }
  for (size_t k = 0; k < edges.size(); k++) {
    const BRepAdaptor_Curve ad(TopoDS::Edge(edges[k]));
    const V a = ad.Value(ad.FirstParameter()).XYZ();
    const V b = ad.Value(ad.LastParameter()).XYZ();
    if (ad.GetType() != GeomAbs_Line) throw FeatureError("Bord tombé : choisissez une arête droite");
    const V u = unit(b - a);
    const double len = (b - a).Modulus();
    const V m = (a + b) * 0.5;
    // Plate carrying the edge: the edge lies on its upper or lower face, parallel to its plane.
    std::optional<std::pair<Rigid, V>> found;
    for (const auto& p : s.plates) {
      const V mid = apply(p.fold, s.mid);
      const V nrm = applyDir(p.fold, s.n);
      const double h = (m - mid).Dot(nrm);
      if (std::abs(std::abs(h) - T / 2) > tol || std::abs(u.Dot(nrm)) > 1e-6) continue;
      if (distanceTo(m, moved(p.flat, p.fold)) > tol) continue;
      found = std::make_pair(p.fold, nrm * (h > 0 ? 1 : -1));
      break;
    }
    if (!found) throw FeatureError("Bord tombé : choisissez une arête du dessus ou du dessous d'une partie plane de la tôle");
    const V n = found->second;
    V w = unit(u.Crossed(n));
    // `w` must point out of the material: the point just beyond the edge, at mid-thickness, is outside the body.
    if (insideBody(prev->shape, m - n * (T / 2) + w * (T / 2), T / 4, u, w, n)) w = -w;
    const double span = len - offStart - offEnd;
    if (span <= 1e-6) throw FeatureError("Les retraits sont plus longs que l'arête");
    const double eps = std::max(T * 0.01, 1e-3);
    const V start = a + u * offStart;
    std::vector<TopoDS_Shape> cuts;
    // Shortening of the plate under the flange (material inside / outside).
    if (setback > 0) cuts.push_back(slab(start - w * setback + n * eps, u * span, w * (setback + eps), n * -(T + 2 * eps)));
    // Bend reliefs at the ends of a flange shorter than the edge: width T, depth R + T.
    if (relief != "none") {
      const double depth = setback + R + T;
      struct End {
        V at, dir;
        double room;
      };
      std::vector<End> reliefs;
      if (offStart > 1e-6) reliefs.push_back({start, -u, offStart});
      if (offEnd > 1e-6) reliefs.push_back({start + u * span, u, offEnd});
      for (const End& e : reliefs) {
        const double w0 = std::min(T, e.room);
        const double straightPart = relief == "round" ? depth - w0 / 2 : depth;
        cuts.push_back(slab(e.at - w * straightPart + n * eps, e.dir * w0, w * (straightPart + eps), n * -(T + 2 * eps)));
        if (relief == "round") {
          const V c = e.at + e.dir * (w0 / 2) - w * straightPart;
          cuts.push_back(cylinder(c + n * eps, -n, w0 / 2, T + 2 * eps));
        }
      }
    }
    // Removals (shortening, reliefs) before the addition of the flange: they do not touch the new bend.
    for (const TopoDS_Shape& c : cuts) {
      cutSheet(s, c);
      Body cut;
      cut.shape = c;
      body = booleanNamed(ctx, {&body, &cut}, true, "relief");
    }
    // Corner extensions, only at the ends without setback.
    const BendResult r = bendFrom(s, found->first, {start - w * setback, u, span, w, n}, angle, up, length,
                                  {offStart > 1e-6 ? 0 : ext[k][0], offEnd > 1e-6 ? 0 : ext[k][1]});
    addBend(s, r, folded);
    const std::string key = edgeKey(k);
    addPiece(ctx, parts, r.foldedBend, "bend(" + key + ")");
    if (r.foldedPlate) addPiece(ctx, parts, *r.foldedPlate, "flange(" + key + ")");
  }
  std::vector<const Body*> ptrs;
  for (const Body& b : parts) ptrs.push_back(&b);
  const Body tool = booleanNamed(ctx, ptrs, false, "flange");
  Body result = booleanNamed(ctx, {&body, &tool}, false, "flange");
  nameMissing(ctx, result, "sheet");
  result.sheet = std::make_shared<const SheetState>(std::move(s));
  result.tool = std::make_shared<const Tool>(Tool{tool.shape, tool.names, false});
  return result;
}

/// Normal cut through the sketch plane, through the whole sheet; carried over into the flat pattern plate by plate.
FeatureOutput buildSheetCut(const BuildContext& ctx) {
  const Body* prev = ctx.prev();
  if (!ctx.sheet() || !prev) throw FeatureError("Créez d'abord une tôle de base");
  const SketchProfile& sk = ctx.sketch("sketch");
  if (sk.faces.empty()) throw FeatureError("L'esquisse ne contient aucun contour fermé");
  const V n = sk.frame.Direction().XYZ();
  const double reach = (std::max(bodyReach(prev, sk.frame.Location()), 1.0) + 1) * 2;
  std::vector<TopoDS_Shape> faces(sk.faces.begin(), sk.faces.end());
  Body tool;
  tool.shape = prism(moved(compoundOf(faces), translation(n * (-reach / 2))), n * reach);
  SheetState s = sheetAfterCut(*ctx.sheet(), tool.shape);
  Body out = combine(ctx, std::move(tool), true);
  out.sheet = std::make_shared<const SheetState>(std::move(s));
  return out;
}

/**
 * Sketched bend: a sketch line drawn on a flat part of the sheet (parallel plane) becomes the axis of a bend
 * (line at the middle of the bent zone). The moving side rotates around the bend, with everything attached to it.
 * The body is rebuilt from the sheet: the Part features applied before are lost.
 */
FeatureOutput buildSketchedBend(const BuildContext& ctx) {
  const Body* prev = ctx.prev();
  const SheetState* sheet = ctx.sheet();
  if (!sheet || !prev) throw FeatureError("Créez d'abord une tôle de base");
  if (sheet->flattened) throw FeatureError("La tôle est mise à plat : placez le pli avant la mise à plat");
  const double deg = ctx.num("angle");
  if (deg <= 0 || deg >= 180) throw FeatureError("L'angle doit être compris entre 0 et 180° (exclus)");
  const double angle = deg * kPi / 180;
  const bool up = ctx.str("direction") != "opposite";
  const bool flip = ctx.str("flip") == "yes";
  const SketchProfile& sk = ctx.sketch("sketch");
  if (sk.segments.empty()) throw FeatureError("Pli sur ligne : l'esquisse doit contenir une ligne");
  const V A = sk.toWorld(sk.segments.front().a).XYZ();
  const V B = sk.toWorld(sk.segments.front().b).XYZ();
  const V ns = sk.frame.Direction().XYZ();
  const double T = sheet->thickness, R = sheet->radius, K = sheet->k;
  const double tol = std::max(refTolerance(prev), T * 0.02);

  // Plate parallel to the sketch plane, under the line.
  int index = -1;
  V n = ns, face;
  for (size_t i = 0; i < sheet->plates.size(); i++) {
    const auto& p = sheet->plates[i];
    const V nrm = applyDir(p.fold, sheet->n);
    const double c = nrm.Dot(ns);
    if (std::abs(std::abs(c) - 1) > 1e-6) continue;
    const V mid = apply(p.fold, sheet->mid);
    const V nn = nrm * (c > 0 ? 1 : -1);
    const V fc = mid + nn * (T / 2);
    const V m = (A + B) * 0.5;
    const V proj = m - nn * (m - fc).Dot(nn);
    if (distanceTo(proj, moved(p.flat, p.fold)) > tol) continue;
    index = int(i);
    n = nn;
    face = fc;
    break;
  }
  if (index < 0)
    throw FeatureError("Pli sur ligne : tracez la ligne sur un plan parallèle à une partie plane de la tôle, au-dessus d'elle");
  auto onFace = [&](const V& P) { return P - n * (P - face).Dot(n); };
  const V a0 = onFace(A);
  const V u = unit(onFace(B) - a0);
  const V w = unit(u.Crossed(n)) * (flip ? -1 : 1);  // towards the moving side
  const double BA = angle * (R + K * T);

  SheetState s = *sheet;
  const SheetState::Plate plate = s.plates[size_t(index)];
  const TopoDS_Shape plateF = moved(plate.flat, plate.fold);
  const auto ext = extentIn(plateF, a0, u, w, n);
  if (!ext) throw FeatureError("Plaque vide");
  double L = 0;
  for (int i = 1; i <= 3; i++) L = std::max({L, std::abs(ext->first.Coord(i)), std::abs(ext->second.Coord(i))});
  L = L * 2 + 10;
  const double eps = std::max(T * 0.01, 1e-3);
  auto region = [&](double w0, double w1) {
    return boolean(Op::Common, plateF, slab(a0 - u * L + w * w0 + n * eps, u * (2 * L), w * (w1 - w0), n * -(T + 2 * eps)));
  };
  const TopoDS_Shape fixedF = region(-L, -BA / 2);
  const TopoDS_Shape zoneF = region(-BA / 2, BA / 2);
  const TopoDS_Shape movingF = region(BA / 2, L);
  if (volume(zoneF) < 1e-9 || volume(movingF) < 1e-9 || volume(fixedF) < 1e-9)
    throw FeatureError("Pli sur ligne : la ligne doit traverser la partie plane, loin de ses bords");
  // Bend length: extent of the bent zone along the line.
  const auto zext = *extentIn(zoneF, a0, u, w, n);
  const V q = a0 + u * zext.first.X() + w * (-BA / 2);
  const double len = zext.second.X() - zext.first.X();
  const BendGeo bg = zoneGeo(*sheet, q, u, len, w, n, angle, up, plate.fold);
  const TopoDS_Shape foldedZone = bendSector(q, u, len, n, T, bg.center, bg.alpha);

  const Rigid toFlat = plate.fold.Inverted();
  const Rigid newFold = compose(rotation(bg.center, u, bg.alpha), compose(translation(w * -BA), plate.fold));
  const Rigid motion = compose(newFold, toFlat);
  // What is attached to the moving side (in the flat pattern) follows the bend.
  const V aFlat = apply(toFlat, a0);
  const V wFlat = applyDir(toFlat, w);
  auto mobile = [&](const TopoDS_Shape& shape) { return (centroid(shape) - aFlat).Dot(wFlat) > 0; };
  for (size_t i = 0; i < s.plates.size(); i++)
    if (int(i) != index && mobile(s.plates[i].flat)) s.plates[i].fold = compose(motion, s.plates[i].fold);
  for (auto& z : s.zones) {
    if (!mobile(z.flat)) continue;
    z.folded = moved(z.folded, motion);
    z.geo = movedGeo(z.geo, motion);
  }
  s.plates.erase(s.plates.begin() + index);
  s.plates.insert(s.plates.begin() + index, {{moved(fixedF, toFlat), plate.fold}, {moved(movingF, toFlat), newFold}});
  s.zones.push_back({moved(zoneF, toFlat), foldedZone, bg.geo});
  const V nFlat = applyDir(toFlat, n);
  s.bends.push_back({apply(toFlat, a0 + u * zext.first.X()), apply(toFlat, a0 + u * zext.second.X()), deg, nFlat.Dot(s.n) > 0 ? up : !up});
  const TopoDS_Shape body = foldedBody(s);
  return sheetBody(ctx, body, std::move(s));
}

/// Flattening: the body becomes the flat pattern (delete the feature to fold it back).
FeatureOutput buildSheetFlat(const BuildContext& ctx) {
  const SheetState* sheet = ctx.sheet();
  if (!sheet) throw FeatureError("Créez d'abord une tôle de base");
  SheetState s = *sheet;
  s.flattened = true;
  return sheetBody(ctx, sheet->flat, std::move(s));
}

SheetState sheetAfterCut(const SheetState& sheet, const TopoDS_Shape& tool) {
  SheetState s = sheet;
  // Compound tool (regions of a sketch, copies of a pattern): each element separately, since overlapping elements
  // do not form a valid boolean argument.
  std::vector<TopoDS_Shape> parts;
  if (tool.ShapeType() == TopAbs_COMPOUND)
    for (TopoDS_Iterator it(tool); it.More(); it.Next()) parts.push_back(it.Value());
  else
    parts.push_back(tool);
  for (const TopoDS_Shape& t : parts) {
    if (!s.flattened) {
      cutSheet(s, t);
      continue;
    }
    // After a flattening, the tool is in the frame of the flat pattern.
    if (volume(boolean(Op::Common, s.flat, t)) <= 1e-9) continue;
    s.flat = boolean(Op::Cut, s.flat, t);
    for (SheetState::Plate& p : s.plates) p.flat = boolean(Op::Cut, p.flat, t);
    for (SheetState::Zone& z : s.zones) z.flat = boolean(Op::Cut, z.flat, t);
  }
  return s;
}

FlatPatternData flatPattern(const SheetState& s) {
  // World → flat pattern frame.
  const Rigid toFrame = frameOf(s.x, s.y, s.n, s.origin).Inverted();
  const ProjectedView view = projectShape(moved(s.flat, toFrame), "top");
  FlatPatternData out;
  out.outline = view.visible;
  out.circles = view.circles;
  for (const SheetState::Bend& b : s.bends) out.bends.push_back({apply(toFrame, b.a), apply(toFrame, b.b), b.angle, b.up});
  out.bounds = view.bounds;
  out.thickness = s.thickness;
  out.radius = s.radius;
  out.kFactor = s.k;
  return out;
}

}  // namespace cad
