// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// From surface to solid: thicken, close into a volume, cut with a surface, replace a face. The surfaces used stay in the
// part, consumed (hidden by default, outside the part as seen from outside). Naming (see core/NAMING.md):
//   - thicken: "<id>/base(F)" and "<id>/thick(F)" for the two skins of the face F, "<id>/wall(E)" for the free edge E;
//   - close: "<id>/closed(F)";
//   - cut: "<id>/cut(F)", face shared by the two sides;
//   - replace: "<id>/replace(F)" where the surface takes the place of the solid face F, "<id>/wall(F).k" for side walls.
#include "part/features.hpp"
#include "part/surftools.hpp"

#include <BOPTools_AlgoTools3D.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepLib.hxx>
#include <BRepOffset_MakeOffset.hxx>
#include <BRepOffset_MakeSimpleOffset.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepTools.hxx>
#include <BRepTools_History.hxx>
#include <BRep_Builder.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <IntTools_Context.hxx>
#include <ShapeFix_Solid.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>

namespace cad {
namespace surf {

/// Faces of the bodies of the parameter `key` (surfaces only).
std::vector<std::string> surfaceIds(const BuildContext& ctx, std::string_view key) {
  std::vector<std::string> ids = bodyIds(ctx.str(key));
  if (ids.empty()) throw FeatureError("Choisissez au moins une surface");
  for (const std::string& id : ids)
    if (ctx.body(id).kind != BodyKind::Surface) throw FeatureError("Un corps choisi n'est pas une surface");
  return ids;
}

std::vector<NamedFace> namedFaces(const Body& b) {
  std::vector<NamedFace> out;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(b.shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++) {
    const std::string* n = b.names.face(faces(i));
    out.push_back({TopoDS::Face(faces(i)), n ? *n : "f" + std::to_string(i)});
  }
  return out;
}

Sewn sew(const BuildContext& ctx, const std::vector<std::string>& ids, double tolerance) {
  BRepBuilderAPI_Sewing sewing(tolerance);
  std::vector<NamedFace> inputs;
  for (const std::string& id : ids) {
    const Body& b = ctx.body(id);
    sewing.Add(b.shape);
    for (NamedFace& f : namedFaces(b)) inputs.push_back(std::move(f));
  }
  sewing.Perform();
  Sewn out{sewing.SewedShape(), {}, {}};
  if (out.shape.IsNull()) throw FeatureError("La couture des surfaces a échoué");
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(out.shape, TopAbs_FACE, faces);
  for (const NamedFace& f : inputs) {
    const TopoDS_Shape sewn = sewing.IsModifiedSubShape(f.face) ? sewing.ModifiedSubShape(f.face) : TopoDS_Shape(f.face);
    if (const int i = faces.FindIndex(sewn); i > 0) {
      out.faces.push_back({TopoDS::Face(faces(i)), f.name});
      out.names.set(faces(i), f.name);
    }
  }
  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes(out.shape, TopAbs_EDGE, edges);
  for (const std::string& id : ids)
    for (const auto& [edge, name] : ctx.body(id).names.explicitEdges()) {
      const TopoDS_Shape sewn = sewing.IsModifiedSubShape(edge) ? sewing.ModifiedSubShape(edge) : edge;
      if (edges.Contains(sewn)) out.names.setEdge(sewn, name);
    }
  return out;
}

/// The only shell of a sewn shape; a single face is wrapped in a shell.
TopoDS_Shell singleShell(const TopoDS_Shape& shape, const char* disjoint) {
  std::vector<TopoDS_Shell> shells;
  for (TopExp_Explorer ex(shape, TopAbs_SHELL); ex.More(); ex.Next()) shells.push_back(TopoDS::Shell(ex.Current()));
  if (shells.size() > 1) throw FeatureError(disjoint);
  if (shells.size() == 1) {
    for (TopExp_Explorer ex(shape, TopAbs_FACE, TopAbs_SHELL); ex.More(); ex.Next()) throw FeatureError(disjoint);
    return shells.front();
  }
  TopoDS_Shell shell;
  BRep_Builder b;
  b.MakeShell(shell);
  int count = 0;
  for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next(), count++) b.Add(shell, ex.Current());
  if (count != 1) throw FeatureError(disjoint);
  return shell;
}

double volumeOf(const TopoDS_Shape& s) {
  GProp_GProps g;
  BRepGProp::VolumeProperties(s, g);
  return g.Mass();
}

double areaOf(const TopoDS_Shape& s) {
  GProp_GProps g;
  BRepGProp::SurfaceProperties(s, g);
  return g.Mass();
}

std::vector<TopoDS_Shape> solidsOf(const TopoDS_Shape& s) {
  std::vector<TopoDS_Shape> out;
  for (TopExp_Explorer ex(s, TopAbs_SOLID); ex.More(); ex.Next()) out.push_back(ex.Current());
  return out;
}

/// A single valid solid, with its normals outward; null otherwise.
TopoDS_Shape validSolid(const TopoDS_Shape& s) {
  if (s.IsNull()) return {};
  const std::vector<TopoDS_Shape> solids = solidsOf(s);
  if (solids.size() != 1) return {};
  TopoDS_Solid solid = TopoDS::Solid(solids.front());
  if (!BRepLib::OrientClosedSolid(solid)) return {};
  if (!BRepCheck_Analyzer(solid).IsValid()) {
    ShapeFix_Solid fix(solid);
    fix.Perform();
    if (!fix.Solid().IsNull() && fix.Solid().ShapeType() == TopAbs_SOLID) solid = TopoDS::Solid(fix.Solid());
    if (!BRepCheck_Analyzer(solid).IsValid()) return {};
  }
  return solid;
}

/// Point inside a face, and its parameters.
gp_Pnt innerPoint(const TopoDS_Face& face, gp_Pnt2d* uv) {
  // One context per call: a shared one keeps a classifier for every face ever seen (memory leak across recomputes).
  const Handle(IntTools_Context) context = new IntTools_Context;
  gp_Pnt p;
  gp_Pnt2d p2;
  if (BOPTools_AlgoTools3D::PointInFace(face, p, p2, context) != 0) throw FeatureError("Face dégénérée");
  if (uv) *uv = p2;
  return p;
}

/// Normal of a face at parameters (u, v), following its orientation.
gp_Vec normalAt(const TopoDS_Face& face, const gp_Pnt2d& uv) {
  BRepGProp_Face prop(face);
  gp_Pnt p;
  gp_Vec n;
  prop.Normal(uv.X(), uv.Y(), p, n);
  return n.Magnitude() > 1e-12 ? n.Normalized() : n;
}

Foot footOn(const std::vector<NamedFace>& faces, const gp_Pnt& p) {
  const TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(p).Vertex();
  Foot foot;
  for (size_t i = 0; i < faces.size(); i++) {
    BRepExtrema_DistShapeShape d(v, faces[i].face);
    if (!d.IsDone() || d.NbSolution() == 0) continue;
    // A boundary point is common to two faces of a shell: an interior solution takes precedence over it.
    const bool inside = d.SupportTypeShape2(1) == BRepExtrema_IsInFace;
    if (d.Value() > foot.distance + kOnShape || (d.Value() > foot.distance - kOnShape && foot.index >= 0 && (!inside || !foot.onBoundary))) continue;
    foot.index = static_cast<int>(i);
    foot.distance = d.Value();
    foot.toPoint = gp_Vec(d.PointOnShape2(1), p);
    foot.support = d.SupportOnShape2(1);
    foot.onBoundary = !inside;
    if (inside) {
      double u, w;
      d.ParOnFaceS2(1, u, w);
      foot.normal = normalAt(faces[i].face, gp_Pnt2d(u, w));
    }
  }
  return foot;
}

/// Solid between a shell and its offset by `offset` (signed, along the normals). The offset with intersection of
/// neighbouring faces keeps sharp corners sharp; the simple offset takes over on the shells it does not handle.
TopoDS_Shape thickSolid(const TopoDS_Shell& shell, double offset) {
  const double expected = areaOf(shell) * std::abs(offset);
  const auto accepted = [&](const TopoDS_Shape& s) {
    TopoDS_Shape solid = validSolid(s);
    if (solid.IsNull()) return TopoDS_Shape();
    const double v = volumeOf(solid);
    return v > expected / 2 && v < expected * 2 ? solid : TopoDS_Shape();
  };
  try {
    BRepOffset_MakeOffset join;
    join.Initialize(shell, offset, 1e-4, BRepOffset_Skin, false, false, GeomAbs_Intersection, true);
    join.MakeOffsetShape();
    if (join.IsDone())
      if (TopoDS_Shape s = accepted(join.Shape()); !s.IsNull()) return s;
  } catch (const Standard_Failure&) {
  }
  BRepOffset_MakeSimpleOffset simple(shell, offset);
  simple.SetBuildSolidFlag(true);
  simple.Perform();
  if (simple.IsDone())
    if (TopoDS_Shape s = accepted(simple.GetResultShape()); !s.IsNull()) return s;
  throw FeatureError("L'épaississement a échoué : réduisez l'épaisseur ou simplifiez la surface");
}

/// Shell offset by `offset`, without thickness.
TopoDS_Shell offsetShell(const TopoDS_Shell& shell, double offset) {
  BRepOffset_MakeOffset mk;
  mk.Initialize(shell, offset, 1e-4, BRepOffset_Skin, false, false, GeomAbs_Intersection);
  mk.MakeOffsetShape();
  if (!mk.IsDone()) throw FeatureError("L'épaississement a échoué : réduisez l'épaisseur ou simplifiez la surface");
  for (TopExp_Explorer ex(mk.Shape(), TopAbs_SHELL); ex.More(); ex.Next()) return TopoDS::Shell(ex.Current());
  throw FeatureError("L'épaississement a échoué : réduisez l'épaisseur ou simplifiez la surface");
}

}  // namespace surf

namespace {

using namespace surf;

/// Names of a thickened solid, from the position of each face relative to the sewn surface (independent of the
/// algorithm that built the solid): skins by distance to the surface, walls facing a free edge. `symmetric`: neither
/// skin lies on the surface, they are told apart by the side of the surface they are on.
TopoNames thickNames(const BuildContext& ctx, const TopoDS_Shape& solid, const Sewn& surface, bool symmetric) {
  TopoNames names;
  UniqueNames unique;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(solid, TopAbs_FACE, faces);
  const std::vector<std::string> edgeNames = surface.names.edgeNames(surface.shape);
  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes(surface.shape, TopAbs_EDGE, edges);
  for (int i = 1; i <= faces.Extent(); i++) {
    const Foot foot = footOn(surface.faces, innerPoint(TopoDS::Face(faces(i))));
    if (foot.index < 0) throw FeatureError("L'épaississement a échoué : réduisez l'épaisseur ou simplifiez la surface");
    const std::string& origin = surface.faces[foot.index].name;
    std::string role;
    if (foot.onBoundary) {
      const int edge = foot.support.ShapeType() == TopAbs_EDGE ? edges.FindIndex(foot.support) : 0;
      role = "wall(" + (edge > 0 ? edgeNames[edge - 1] : origin) + ")";
    } else if (symmetric) {
      role = (foot.toPoint.Dot(foot.normal) >= 0 ? "thick(" : "base(") + origin + ")";
    } else {
      role = (foot.distance < kOnShape ? "base(" : "thick(") + origin + ")";
    }
    names.set(faces(i), unique(ctx.name(role)));
  }
  return names;
}

/// Combines the solid `tool` with the target body according to `op`, and marks the surfaces as consumed.
FeatureOutput solidResult(const BuildContext& ctx, Body tool, std::vector<std::string> consumed) {
  Body out = combine(ctx, std::move(tool));
  BodyChanges changes;
  changes.consumed = std::move(consumed);
  if (out.created || !ctx.prev())
    changes.created.push_back(std::move(out));
  else
    changes.target = std::move(out);
  return changes;
}

/// The surface of the parameter `key`, exactly one.
std::string singleSurface(const BuildContext& ctx, std::string_view key) {
  const std::vector<std::string> ids = surfaceIds(ctx, key);
  if (ids.size() != 1) throw FeatureError("Choisissez une seule surface");
  return ids.front();
}

const Body& solidTarget(const BuildContext& ctx) {
  const Body* b = ctx.prev();
  if (!b) throw FeatureError("Aucun corps cible");
  return *b;
}

/// Is a fragment on the side the normals of the surface point to? Decided on a face of the fragment lying on the
/// surface: the outward normal of the fragment there is opposed to the normal of the surface. nullopt: no such face.
std::optional<bool> onNormalSide(const TopoDS_Shape& fragment, const std::vector<NamedFace>& surface) {
  for (TopExp_Explorer ex(fragment, TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Face f = TopoDS::Face(ex.Current());
    gp_Pnt2d uv;
    const gp_Pnt p = innerPoint(f, &uv);
    const Foot foot = footOn(surface, p);
    if (foot.index < 0 || foot.distance > kOnShape || foot.onBoundary) continue;
    return normalAt(f, uv).Dot(foot.normal) < 0;
  }
  return std::nullopt;
}

}  // namespace

/// Thickens the surfaces `surfaces` (sewn along their common edges, in one piece) by `thickness`: on the side of their
/// normal (`side` = "normal"), on the other side ("reverse") or on both ("symmetric"). The solid is added to the target
/// body, removed from it, or becomes a new body according to `op`. The surfaces are consumed.
FeatureOutput buildThicken(const BuildContext& ctx) {
  const std::vector<std::string> ids = surfaceIds(ctx, "surfaces");
  const double t = ctx.positive("thickness");
  const std::string side = ctx.str("side");
  Sewn surface = sew(ctx, ids);
  const TopoDS_Shell shell = singleShell(surface.shape, "Les surfaces à épaissir doivent former un seul morceau");
  surface.shape = shell;
  TopoDS_Shape solid;
  if (side == "symmetric")
    solid = thickSolid(offsetShell(shell, t / 2), -t);
  else
    solid = thickSolid(shell, side == "reverse" ? -t : t);
  Body tool;
  tool.names = thickNames(ctx, solid, surface, side == "symmetric");
  tool.shape = std::move(solid);
  return solidResult(ctx, std::move(tool), ids);
}

/// Closes the surfaces `surfaces`, which together must bound a volume, into a solid. `op` as for thicken.
FeatureOutput buildCloseSurface(const BuildContext& ctx) {
  const std::vector<std::string> ids = surfaceIds(ctx, "surfaces");
  const Sewn surface = sew(ctx, ids);
  const std::vector<bool> free = TopoNames::freeEdges(surface.shape);
  if (const auto open = std::count(free.begin(), free.end(), true); open > 0)
    throw FeatureError("Les surfaces ne ferment pas un volume : " + std::to_string(open) + " bord(s) libre(s)");
  const TopoDS_Shell shell = singleShell(surface.shape, "Les surfaces ne ferment pas un seul volume");
  BRepBuilderAPI_MakeSolid mk(shell);
  if (!mk.IsDone()) throw FeatureError("Les surfaces ne ferment pas un seul volume");
  TopoDS_Shape solid = validSolid(mk.Solid());
  if (solid.IsNull()) throw FeatureError("Le volume obtenu est invalide");
  Body tool;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(solid, TopAbs_FACE, faces);
  UniqueNames unique;
  for (const NamedFace& f : surface.faces)
    if (const int i = faces.FindIndex(f.face); i > 0) tool.names.set(faces(i), unique(ctx.name("closed(" + f.name + ")")));
  tool.shape = std::move(solid);
  return solidResult(ctx, std::move(tool), ids);
}

/// Cuts the target body with the surface `surface`, which must cross it: `keep` = "normal" keeps the side its normal
/// points to, "reverse" the other one, "both" keeps both sides as separate bodies (first the normal side).
FeatureOutput buildCutWithSurface(const BuildContext& ctx) {
  const Body& base = solidTarget(ctx);
  const std::string id = singleSurface(ctx, "surface");
  const Body& surface = ctx.body(id);
  const std::string keep = ctx.str("keep");
  BRepAlgoAPI_Splitter splitter;
  TopTools_ListOfShape args, tools, all;
  args.Append(base.shape);
  tools.Append(surface.shape);
  all.Append(base.shape);
  all.Append(surface.shape);
  splitter.SetArguments(args);
  splitter.SetTools(tools);
  splitter.Build();
  if (!splitter.IsDone() || splitter.HasErrors()) throw FeatureError("La découpe a échoué");
  const std::vector<TopoDS_Shape> pieces = solidsOf(splitter.Shape());
  if (pieces.size() < 2) throw FeatureError("La surface ne traverse pas le solide : prolongez-la au-delà de ses bords");

  const std::vector<NamedFace> faces = namedFaces(surface);
  std::vector<TopoDS_Shape> normal, reverse;
  for (const TopoDS_Shape& piece : pieces) {
    const std::optional<bool> side = onNormalSide(piece, faces);
    if (!side) throw FeatureError("La surface ne traverse pas le solide : prolongez-la au-delà de ses bords");
    (*side ? normal : reverse).push_back(piece);
  }
  if (keep != "reverse" && normal.empty()) throw FeatureError("Rien ne reste du côté de la normale");
  if (keep == "reverse" && reverse.empty()) throw FeatureError("Rien ne reste du côté opposé à la normale");
  const auto order = [](const TopoDS_Shape& a, const TopoDS_Shape& b) { return shapeCenter(a) < shapeCenter(b); };
  std::stable_sort(normal.begin(), normal.end(), order);
  std::stable_sort(reverse.begin(), reverse.end(), order);

  // Faces of the surface: "cut(F)". They are shared by the pieces of both sides, like the plane of a split.
  TopoNames surfaceNames;
  for (const NamedFace& f : faces) surfaceNames.set(f.face, ctx.name("cut(" + f.name + ")"));
  const BRepTools_History history(all, splitter);
  const TopoNames names = TopoNames::derive(splitter.Shape(), {{&base.shape, &base.names}, {&surface.shape, &surfaceNames}}, history,
                                            [&](const std::string& origin) { return ctx.name("gen(" + origin + ")"); });
  std::vector<TopoDS_Shape> kept = keep == "reverse" ? reverse : normal;
  if (keep == "both") kept.insert(kept.end(), reverse.begin(), reverse.end());
  BodyChanges changes;
  changes.consumed.push_back(id);
  for (size_t k = 0; k < kept.size(); k++) {
    Body piece;
    piece.shape = kept[k];
    piece.names = names;
    if (k == 0)
      changes.target = std::move(piece);
    else
      changes.created.push_back(std::move(piece));
  }
  return changes;
}

/// Replaces faces of the target body (group "faces") by a surface (body of the element of the group "surface").
/// The defined behaviour: the column of each face, along its outward normal, is cut by the surface. Below the surface,
/// the column fills the space above the face; above it, the column empties the solid under the face. The neighbouring
/// faces are thus extended along the normal (top of a boss, bottom of a pocket).
FeatureOutput buildReplaceFace(const BuildContext& ctx) {
  const Body& base = solidTarget(ctx);
  const std::vector<GroupRef> picked = resolveGroup(ctx, TopAbs_FACE, "faces");
  if (picked.empty()) throw FeatureError("Choisissez les faces à remplacer");
  for (const GroupRef& r : picked)
    if (r.body != ctx.targetId()) throw FeatureError("Les faces à remplacer doivent appartenir au corps cible");
  const std::vector<GroupRef> chosen = resolveGroup(ctx, TopAbs_FACE, "surface");
  if (chosen.size() != 1) throw FeatureError("Choisissez une seule surface de remplacement");
  const Body& surface = ctx.body(chosen.front().body);
  if (surface.kind != BodyKind::Surface) throw FeatureError("La face de remplacement doit appartenir à une surface");
  const std::vector<NamedFace> surfaceFaces = namedFaces(surface);

  Bnd_Box box;
  BRepBndLib::Add(base.shape, box, false);
  BRepBndLib::Add(surface.shape, box, false);
  const double length = 2 * std::sqrt(box.SquareExtent()) + 1;

  std::vector<Body> added, removed;
  for (const GroupRef& r : picked) {
    const TopoDS_Face face = TopoDS::Face(r.shape);
    const std::string* faceName = base.names.face(face);
    const std::string origin = faceName ? *faceName : "?";
    gp_Pnt2d uv;
    innerPoint(face, &uv);
    const gp_Vec n = normalAt(face, uv);

    // Column of the face on both sides, split by the surface.
    gp_Trsf down;
    down.SetTranslation(n * -length);
    const TopoDS_Shape start = BRepBuilderAPI_Transform(face, down, true).Shape();
    BRepPrimAPI_MakePrism column(start, n * (2 * length));
    if (!column.IsDone()) throw FeatureError("La colonne de la face n'a pas pu être construite");
    BRepAlgoAPI_Splitter splitter;
    TopTools_ListOfShape args, tools;
    args.Append(column.Shape());
    tools.Append(surface.shape);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (!splitter.IsDone() || splitter.HasErrors()) throw FeatureError("La découpe de la colonne a échoué");

    // A surface covering the face separates the two ends of the column. A fragment touching both: a way past the surface.
    const auto touches = [](const TopoDS_Shape& fragment, const TopoDS_Shape& cap) {
      BRepExtrema_DistShapeShape d(fragment, cap);
      return d.IsDone() && d.Value() < kOnShape;
    };
    std::vector<TopoDS_Shape> under, over;
    for (const TopoDS_Shape& piece : solidsOf(splitter.Shape())) {
      const bool low = touches(piece, column.FirstShape()), high = touches(piece, column.LastShape());
      if (low == high) throw FeatureError("La surface ne couvre pas toute la face à remplacer : prolongez-la");
      (low ? under : over).push_back(piece);
    }
    if (under.empty() || over.empty()) throw FeatureError("La surface ne couvre pas toute la face à remplacer : prolongez-la");

    // Parts of the column that change the solid: under the surface and above the face, over the surface and below it.
    const TopoDS_Shape up = BRepPrimAPI_MakePrism(face, n * length).Shape();
    const TopoDS_Shape below = BRepPrimAPI_MakePrism(face, n * -length).Shape();
    UniqueNames unique;
    const auto part = [&](const std::vector<TopoDS_Shape>& fragments, const TopoDS_Shape& side, std::vector<Body>& out) {
      for (const TopoDS_Shape& fragment : fragments) {
        BRepAlgoAPI_Common common(fragment, side);
        if (!common.IsDone() || common.HasErrors()) throw FeatureError("L'opération booléenne a échoué");
        for (const TopoDS_Shape& solid : solidsOf(common.Shape())) {
          Body body;
          body.shape = solid;
          int walls = 0;
          TopTools_IndexedMapOfShape faces;
          TopExp::MapShapes(solid, TopAbs_FACE, faces);
          for (int i = 1; i <= faces.Extent(); i++) {
            const Foot foot = footOn(surfaceFaces, innerPoint(TopoDS::Face(faces(i))));
            const bool onSurface = foot.index >= 0 && foot.distance < kOnShape;
            body.names.set(faces(i), onSurface ? unique(ctx.name("replace(" + origin + ")")) : ctx.name("wall(" + origin + ")." + std::to_string(++walls)));
          }
          out.push_back(std::move(body));
        }
      }
    };
    part(under, up, added);
    part(over, below, removed);
  }
  if (added.empty() && removed.empty()) throw FeatureError("La surface se confond avec la face à remplacer");

  std::vector<const Body*> parts{&base};
  for (const Body& b : added) parts.push_back(&b);
  const Body filled = booleanNamed(ctx, parts, false, "replace");
  parts = {&filled};
  for (const Body& b : removed) parts.push_back(&b);
  Body out = booleanNamed(ctx, parts, true, "replace");
  out.shape = validSolid(out.shape);
  if (out.shape.IsNull()) throw FeatureError("Le remplacement donne un corps invalide");
  BodyChanges changes;
  changes.consumed.push_back(chosen.front().body);
  changes.target = std::move(out);
  return changes;
}

}  // namespace cad
