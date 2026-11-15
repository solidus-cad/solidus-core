// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Editing surfaces: offset, knit, trim (and mutual trim), extend, extract faces. Each feature creates a new surface
// body; the surfaces it transforms stay in the part, consumed. Names (core/NAMING.md), F being the name of the origin
// face: "<id>/offset(F)", "<id>/knit(F)", "<id>/trim(F)" (edge along the tool face T: "e(<id>/trim(F)|<id>/cut(T))"),
// "<id>/extend(F)" for an extended face and "<id>/copy(F)" for the others, "<id>/face(F)" for an extracted face.
// A face of an origin split into several kept pieces is told apart as #k.
#include "part/features.hpp"
#include "part/surftools.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepOffset_MakeSimpleOffset.hxx>
#include <BRepTools.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <GeomConvert.hxx>
#include <GeomLib.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_Surface.hxx>
#include <ShapeFix_Shell.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <gp_Pln.hxx>

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>

namespace cad {
namespace {

using namespace surf;

gp_XYZ xyz(const Json& j) { return gp_XYZ(j.at(0).get<double>(), j.at(1).get<double>(), j.at(2).get<double>()); }

Body surfaceBody(TopoDS_Shape shape, TopoNames names) {
  Body out;
  out.shape = std::move(shape);
  out.names = std::move(names);
  out.created = true;
  out.kind = BodyKind::Surface;
  return out;
}

FeatureOutput created(Body body, std::vector<std::string> consumed) {
  BodyChanges changes;
  changes.created.push_back(std::move(body));
  changes.consumed = std::move(consumed);
  return changes;
}

/// Names the faces of `shape` after the origin face (closest face of `origin`): "<id>/<role>(F)".
TopoNames namesByOrigin(const BuildContext& ctx, const TopoDS_Shape& shape, const std::vector<NamedFace>& origin, const std::string& role) {
  TopoNames names;
  UniqueNames unique;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++) {
    const Foot foot = footOn(origin, innerPoint(TopoDS::Face(faces(i))));
    if (foot.index < 0) throw FeatureError("Face d'origine introuvable");
    names.set(faces(i), unique(ctx.name(role + "(" + origin[foot.index].name + ")")));
  }
  return names;
}

/// Faces sewn into shells (pieces already sharing their edges are only assembled).
TopoDS_Shape assemble(const std::vector<TopoDS_Shape>& faces, double tolerance = 1e-6) {
  BRepBuilderAPI_Sewing sewing(tolerance);
  for (const TopoDS_Shape& f : faces) sewing.Add(f);
  sewing.Perform();
  return sewing.SewedShape();
}

}  // namespace

/// Offset of the surfaces `surfaces` (sewn, in one piece) by `distance` along their normals (`reverse`: the other way).
FeatureOutput buildOffsetSurface(const BuildContext& ctx) {
  const std::vector<std::string> ids = surfaceIds(ctx, "surfaces");
  const double d = ctx.positive("distance") * (ctx.str("reverse") == "yes" ? -1 : 1);
  const Sewn surface = sew(ctx, ids);
  const TopoDS_Shell shell = singleShell(surface.shape, "Les surfaces à décaler doivent former un seul morceau");
  TopoDS_Shape out;
  try {
    out = offsetShell(shell, d);
  } catch (const FeatureError&) {
    // Offset with intersection of neighbours not possible: simple offset (faces moved independently, then joined).
    BRepOffset_MakeSimpleOffset simple(shell, d);
    simple.Perform();
    if (simple.IsDone()) out = simple.GetResultShape();
  }
  if (out.IsNull() || !BRepCheck_Analyzer(out, true).IsValid())
    throw FeatureError("Le décalage a échoué : réduisez la distance (rayon de courbure trop petit ?)");
  return created(surfaceBody(out, namesByOrigin(ctx, out, surface.faces, "offset")), ids);
}

/// Knits the surfaces `surfaces` (at least two) along their edges closer than `tolerance`. `solid` = "yes": the
/// result must be closed, it becomes a solid body.
FeatureOutput buildKnitSurface(const BuildContext& ctx) {
  const std::vector<std::string> ids = surfaceIds(ctx, "surfaces");
  if (ids.size() < 2) throw FeatureError("Choisissez au moins deux surfaces à coudre");
  const double tolerance = ctx.positive("tolerance");
  const Sewn surface = sew(ctx, ids, tolerance);
  TopoDS_Shape shape = surface.shape;
  const bool solid = ctx.str("solid") == "yes";
  if (solid) {
    const std::vector<bool> free = TopoNames::freeEdges(shape);
    if (const auto open = std::count(free.begin(), free.end(), true); open > 0)
      throw FeatureError("La couture n'est pas fermée : " + std::to_string(open) + " bord(s) libre(s) (augmentez la tolérance ?)");
    // The sewn pieces may come with opposite orientations (a mutual trim keeps the tool faces as they were):
    // the faces of the shell are oriented consistently first, otherwise one face stays inside out in the solid
    // (displayed from the wrong side, lost by a later fillet or shell).
    ShapeFix_Shell orient(singleShell(shape, "La couture ne donne pas un seul volume"));
    orient.FixFaceOrientation(orient.Shell());
    BRepBuilderAPI_MakeSolid mk(orient.Shell());
    shape = mk.IsDone() ? validSolid(mk.Solid()) : TopoDS_Shape();
    if (shape.IsNull()) throw FeatureError("Le volume cousu est invalide");
  } else {
    singleShell(shape, "Les surfaces ne se touchent pas (augmentez la tolérance ?)");
  }
  // Own copy: the sewing reuses the faces of the knitted surfaces, which stay in the part (consumed, hidden). A face
  // shared by two bodies with opposite orientations would be displayed with the orientation of the first one.
  shape = BRepBuilderAPI_Copy(shape).Shape();
  Body out = surfaceBody(shape, namesByOrigin(ctx, shape, surface.faces, "knit"));
  if (solid) out.kind = BodyKind::Solid;
  return created(std::move(out), ids);
}

/// Copies the designated faces (group "faces", of any body) into a new surface body; the source body is kept.
FeatureOutput buildExtractFaces(const BuildContext& ctx) {
  const std::vector<GroupRef> picked = resolveGroup(ctx, TopAbs_FACE, "faces");
  if (picked.empty()) throw FeatureError("Désignez les faces à extraire");
  TopoDS_Compound all;
  BRep_Builder b;
  b.MakeCompound(all);
  std::vector<NamedFace> origin;
  for (const GroupRef& g : picked) {
    b.Add(all, g.shape);
    const std::string* n = ctx.body(g.body).names.face(g.shape);
    origin.push_back({TopoDS::Face(g.shape), n ? *n : "f"});
  }
  // Faces of one body share their edges in the copy: sewing only assembles them into shells.
  BRepBuilderAPI_Copy copy(all);
  std::vector<TopoDS_Shape> faces;
  for (TopExp_Explorer ex(copy.Shape(), TopAbs_FACE); ex.More(); ex.Next()) faces.push_back(ex.Current());
  const TopoDS_Shape shape = assemble(faces, kSewing);
  return created(surfaceBody(shape, namesByOrigin(ctx, shape, origin, "face")), {});
}

namespace {

/// Side of a point relative to a trimming tool: true on the side of its normal (outside for a solid).
using SideOf = std::function<bool(const gp_Pnt&)>;

struct TrimTool {
  TopoDS_Shape shape;
  std::vector<NamedFace> faces;  // to name the cut edges
  SideOf side;
};

TrimTool surfaceTool(const Body& body) {
  TrimTool t{body.shape, namedFaces(body), {}};
  t.side = [faces = t.faces](const gp_Pnt& p) {
    const Foot foot = footOn(faces, p);
    return foot.index >= 0 && foot.toPoint.Dot(foot.normal) > 0;
  };
  return t;
}

/// Kept pieces of `target` split by `tool`: the faces on the side `keepNormal`, named "<id>/trim(F)".
struct Trimmed {
  std::vector<TopoDS_Shape> faces;
  std::vector<NamedFace> named;
};

Trimmed trim(const BuildContext& ctx, const Body& target, const TrimTool& tool, bool keepNormal, UniqueNames& unique) {
  BRepAlgoAPI_Splitter split;
  TopTools_ListOfShape args, tools;
  args.Append(target.shape);
  tools.Append(tool.shape);
  split.SetArguments(args);
  split.SetTools(tools);
  split.Build();
  if (!split.IsDone() || split.HasErrors()) throw FeatureError("La découpe de la surface a échoué");
  const std::vector<NamedFace> origin = namedFaces(target);
  // Origin of each piece, through the history of the split.
  std::vector<std::pair<TopoDS_Shape, std::string>> pieces;
  bool cut = false;
  for (const NamedFace& f : origin) {
    const TopTools_ListOfShape& modified = split.Modified(f.face);
    if (modified.Extent() > 1) cut = true;
    if (modified.IsEmpty())
      pieces.push_back({f.face, f.name});
    else
      for (const TopoDS_Shape& m : modified) pieces.push_back({m, f.name});
  }
  if (!cut) throw FeatureError("L'outil ne coupe pas la surface");
  Trimmed out;
  for (const auto& [piece, name] : pieces) {
    if (tool.side(innerPoint(TopoDS::Face(piece))) != keepNormal) continue;
    out.faces.push_back(piece);
    out.named.push_back({TopoDS::Face(piece), unique(ctx.name("trim(" + name + ")"))});
  }
  if (out.faces.empty()) throw FeatureError("Rien ne reste de la surface de ce côté : choisissez l'autre côté");
  return out;
}

}  // namespace

/// Trims the surface `surface` with a tool (`toolKind`): a body `tool` (surface: side of its normal; solid: outside
/// or inside) or a plane (`prepared.frame`). `keep` = "normal" keeps the side of the normal (outside of a solid),
/// "reverse" the other. `mutual` = "yes" (surface tool): the tool is trimmed by the surface as well (`keepTool`), both
/// kept parts are knitted into one body.
FeatureOutput buildTrimSurface(const BuildContext& ctx) {
  const std::vector<std::string> ids = surfaceIds(ctx, "surface");
  if (ids.size() != 1) throw FeatureError("Choisissez une seule surface à découper");
  const Body& target = ctx.body(ids.front());
  const bool keepNormal = ctx.str("keep") != "reverse";
  TrimTool tool;
  std::string toolId;
  if (ctx.str("toolKind") == "plane") {
    ctx.num("offset");
    const Json& prepared = ctx.feature().prepared;
    const auto frame = prepared.find("frame");
    if (frame == prepared.end()) throw FeatureError("Plan introuvable ou en erreur");
    const gp_Pnt origin(xyz(frame->at("origin")));
    const gp_Dir n(xyz(frame->at("normal")));
    const double size = bodyReach(&target, origin) * 2 + 1;
    const TopoDS_Face face = BRepBuilderAPI_MakeFace(gp_Pln(origin, n), -size, size, -size, size).Face();
    tool = {face, {{face, "plane"}}, [origin, n](const gp_Pnt& p) { return gp_Vec(origin, p).Dot(gp_Vec(n)) > 0; }};
  } else {
    const std::vector<std::string> tid = bodyIds(ctx.str("tool"));
    if (tid.size() != 1) throw FeatureError("Choisissez un corps outil");
    if (tid.front() == ids.front()) throw FeatureError("L'outil doit être un autre corps que la surface");
    toolId = tid.front();
    const Body& b = ctx.body(toolId);
    if (b.kind == BodyKind::Surface) {
      tool = surfaceTool(b);
    } else {
      tool = {b.shape, namedFaces(b), [shape = b.shape](const gp_Pnt& p) {
                BRepClass3d_SolidClassifier c(shape, p, 1e-6);
                return c.State() == TopAbs_OUT;
              }};
    }
  }
  const bool mutual = ctx.str("mutual") == "yes" && !toolId.empty() && ctx.body(toolId).kind == BodyKind::Surface;
  UniqueNames unique;
  Trimmed kept;
  std::vector<std::string> consumed{ids.front()};
  try {
    kept = trim(ctx, target, tool, keepNormal, unique);
    if (mutual) {
      Trimmed other = trim(ctx, ctx.body(toolId), surfaceTool(target), ctx.str("keepTool") != "reverse", unique);
      kept.faces.insert(kept.faces.end(), other.faces.begin(), other.faces.end());
      kept.named.insert(kept.named.end(), other.named.begin(), other.named.end());
      consumed.push_back(toolId);
    }
  } catch (const Standard_Failure& e) {
    throw FeatureError(std::string("La découpe de la surface a échoué (") + e.GetMessageString() + ")");
  }
  const TopoDS_Shape shape = assemble(kept.faces, mutual ? kSewing : 1e-6);
  // Names of the kept pieces, found again in the assembled shape (sewing may rebuild the faces).
  TopoNames finalNames;
  {
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    for (int i = 1; i <= faces.Extent(); i++) {
      const Foot foot = footOn(kept.named, innerPoint(TopoDS::Face(faces(i))));
      finalNames.set(faces(i), kept.named[foot.index].name);
    }
  }
  // Free edges along the tool: through the virtual face "<id>/cut(T)", T being the tool face they lie on.
  TopTools_IndexedDataMapOfShapeListOfShape owners;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  for (int i = 1; i <= owners.Extent(); i++) {
    if (owners(i).Extent() != 1) continue;
    const TopoDS_Edge& e = TopoDS::Edge(owners.FindKey(i));
    BRepAdaptor_Curve c(e);
    const gp_Pnt mid = c.Value((c.FirstParameter() + c.LastParameter()) / 2);
    const Foot foot = footOn(tool.faces, mid);
    if (foot.index < 0 || foot.distance > 1e-4) continue;
    const std::string* face = finalNames.face(owners(i).First());
    if (face) finalNames.setEdge(e, TopoNames::edgeName({*face, ctx.name("cut(" + tool.faces[foot.index].name + ")")}));
  }
  return created(surfaceBody(shape, std::move(finalNames)), consumed);
}

namespace {

/// Sides of the UV rectangle of `face` along which the edge lies: (uMin, uMax, vMin, vMax).
std::array<bool, 4> sidesOf(const TopoDS_Edge& edge, const TopoDS_Face& face) {
  double u0, u1, v0, v1;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  double f, l;
  const Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(edge, face, f, l);
  if (pc.IsNull()) return {false, false, false, false};
  const double tol = 1e-7 * std::max({1.0, std::abs(u1 - u0), std::abs(v1 - v0)});
  std::array<bool, 4> on{true, true, true, true};
  for (const double t : {f, (f + l) / 2, l}) {
    const gp_Pnt2d p = pc->Value(t);
    on[0] = on[0] && std::abs(p.X() - u0) < tol;
    on[1] = on[1] && std::abs(p.X() - u1) < tol;
    on[2] = on[2] && std::abs(p.Y() - v0) < tol;
    on[3] = on[3] && std::abs(p.Y() - v1) < tol;
  }
  return on;
}

/// Face whose surface is its UV rectangle (not trimmed by other curves): only those can be extended.
bool untrimmed(const TopoDS_Face& face) {
  double u0, u1, v0, v1;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  const TopoDS_Face full = BRepBuilderAPI_MakeFace(BRep_Tool::Surface(face), u0, u1, v0, v1, 1e-7).Face();
  const double a = areaOf(face);
  return std::abs(areaOf(full) - a) < 1e-6 * std::max(a, 1.0);
}

}  // namespace

/// Extends the faces along the designated free edges (group "edges") by `length`: "natural" (the surface continues with
/// its curvature) or "linear" (tangent continuation). The faces must not be trimmed (their boundary is their UV
/// rectangle). The neighbouring faces are knitted again with the extended faces.
FeatureOutput buildExtendSurface(const BuildContext& ctx) {
  const std::vector<GroupRef> picked = resolveGroup(ctx, TopAbs_EDGE, "edges");
  if (picked.empty()) throw FeatureError("Désignez les arêtes libres à prolonger");
  const double length = ctx.positive("length");
  const int cont = ctx.str("mode") == "linear" ? 1 : 2;
  std::vector<std::string> ids;
  for (const GroupRef& g : picked)
    if (std::find(ids.begin(), ids.end(), g.body) == ids.end()) ids.push_back(g.body);
  for (const std::string& id : ids)
    if (ctx.body(id).kind != BodyKind::Surface) throw FeatureError("Seules les arêtes libres d'une surface se prolongent");
  // Sides to extend, per face.
  std::vector<std::pair<TopoDS_Face, std::array<bool, 4>>> extend;
  const auto entry = [&](const TopoDS_Shape& f) {
    return std::find_if(extend.begin(), extend.end(), [&](const auto& e) { return e.first.IsSame(f); });
  };
  for (const GroupRef& g : picked) {
    TopTools_IndexedDataMapOfShapeListOfShape owners;
    TopExp::MapShapesAndAncestors(ctx.body(g.body).shape, TopAbs_EDGE, TopAbs_FACE, owners);
    const TopTools_ListOfShape* faces = owners.Seek(g.shape);
    if (!faces || faces->Extent() != 1) throw FeatureError("Seules les arêtes libres d'une surface se prolongent");
    const TopoDS_Face face = TopoDS::Face(faces->First());
    const std::array<bool, 4> on = sidesOf(TopoDS::Edge(g.shape), face);
    if (std::none_of(on.begin(), on.end(), [](bool b) { return b; })) throw FeatureError("Cette arête ne borde pas sa face sur tout un côté : prolongement impossible");
    auto it = entry(face);
    if (it == extend.end()) it = extend.insert(extend.end(), {face, {false, false, false, false}});
    for (int k = 0; k < 4; k++) it->second[k] = it->second[k] || on[k];
  }
  BRepTools_ReShape reshape;
  std::vector<NamedFace> origin;
  for (const auto& [face, sides] : extend) {
    if (!untrimmed(face)) throw FeatureError("Seules les faces non découpées se prolongent");
    double u0, u1, v0, v1;
    BRepTools::UVBounds(face, u0, u1, v0, v1);
    Handle(Geom_BSplineSurface) bs;
    try {
      bs = GeomConvert::SurfaceToBSplineSurface(new Geom_RectangularTrimmedSurface(BRep_Tool::Surface(face), u0, u1, v0, v1));
      Handle(Geom_BoundedSurface) s = bs;
      // (inU, after) for uMin, uMax, vMin, vMax.
      const std::pair<bool, bool> dirs[] = {{true, false}, {true, true}, {false, false}, {false, true}};
      for (int k = 0; k < 4; k++)
        if (sides[k]) GeomLib::ExtendSurfByLength(s, length, cont, dirs[k].first, dirs[k].second);
      bs = Handle(Geom_BSplineSurface)::DownCast(s);
    } catch (const Standard_Failure& e) {
      throw FeatureError(std::string("Le prolongement a échoué (") + e.GetMessageString() + ")");
    }
    if (bs.IsNull()) throw FeatureError("Le prolongement a échoué");
    TopoDS_Face grown = BRepBuilderAPI_MakeFace(bs, 1e-7).Face();
    if (face.Orientation() == TopAbs_REVERSED) grown.Reverse();
    reshape.Replace(face, grown);
  }
  // Every face of the bodies concerned, in the new body: extended or copied.
  std::vector<TopoDS_Shape> faces;
  for (const std::string& id : ids) {
    const Body& b = ctx.body(id);
    const TopoDS_Shape applied = reshape.Apply(b.shape);
    for (TopExp_Explorer ex(b.shape, TopAbs_FACE); ex.More(); ex.Next()) {
      const std::string* n = b.names.face(ex.Current());
      const TopoDS_Shape now = reshape.Value(ex.Current());
      const bool grew = entry(ex.Current()) != extend.end();
      origin.push_back({TopoDS::Face(now), ctx.name((grew ? "extend(" : "copy(") + (n ? *n : std::string("f")) + ")")});
    }
    for (TopExp_Explorer ex(applied, TopAbs_FACE); ex.More(); ex.Next()) faces.push_back(ex.Current());
  }
  const TopoDS_Shape shape = assemble(faces, kSewing);
  if (shape.IsNull() || !BRepCheck_Analyzer(shape, true).IsValid()) throw FeatureError("Le prolongement donne une surface invalide");
  TopoNames names;
  UniqueNames unique;
  TopTools_IndexedMapOfShape all;
  TopExp::MapShapes(shape, TopAbs_FACE, all);
  for (int i = 1; i <= all.Extent(); i++) {
    const Foot foot = footOn(origin, innerPoint(TopoDS::Face(all(i))));
    if (foot.index >= 0) names.set(all(i), unique(origin[foot.index].name));
  }
  return created(surfaceBody(shape, std::move(names)), ids);
}

}  // namespace cad
