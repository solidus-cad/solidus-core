// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Draft: faces tilted by an angle around their line on a neutral plane, so that a moulded part comes out of the mould.
//   - neutral plane: the faces pivot around their intersection with the plane; the pull direction is its normal;
//   - parting line: the faces are first split by the plane, each side is drafted away from it (the part is widest
//     on the parting line, both halves of the mould come off).
// The plane is a planar face of the body (group "neutral"), a base or reference plane (`prepared.frame` + offset), or
// automatic: pull direction deduced from the faces (upward), each face keeps its size at its base (the top if
// reversed); parting line in the middle of the faces.
// Drafted faces keep their names; faces split by the parting line become "<name>#k".
#include "part/features.hpp"
#include "part/surftools.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepGProp.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <BRepTools_History.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp.hxx>
#include <gp_Pln.hxx>

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <utility>
#include <vector>

namespace cad {
namespace {

gp_XYZ xyz(const Json& j) { return gp_XYZ(j.at(0).get<double>(), j.at(1).get<double>(), j.at(2).get<double>()); }

/// Neutral plane, with its normal as pull direction (before `reverse`): from a face of the body, the normal into the
/// material; from a plane, its normal.
gp_Pln neutralPlane(const BuildContext& ctx, const Body& body) {
  if (ctx.str("neutralFrom") != "plane") {
    const std::vector<TopoDS_Shape> picked = resolveRefs(ctx.feature().refs, body, TopAbs_FACE, "neutral");
    if (picked.size() != 1) throw FeatureError("Choisissez une face plane comme plan neutre");
    const TopoDS_Face face = TopoDS::Face(picked.front());
    BRepAdaptor_Surface s(face, false);
    if (s.GetType() != GeomAbs_Plane) throw FeatureError("Le plan neutre doit être une face plane");
    gp_Pnt2d uv;
    const gp_Pnt p = surf::innerPoint(face, &uv);
    // Normal into the material: the face keeps its size, the part narrows away from it.
    return gp_Pln(p, gp_Dir(surf::normalAt(face, uv).Reversed()));
  }
  ctx.num("offset");
  const Json& prepared = ctx.feature().prepared;
  const auto frame = prepared.find("frame");
  if (frame == prepared.end()) throw FeatureError("Plan introuvable ou en erreur");
  return gp_Pln(gp_Pnt(xyz(frame->at("origin"))), gp_Dir(xyz(frame->at("normal"))));
}

/// `d` turned upward: +Z, otherwise +Y, otherwise +X.
gp_Dir upward(const gp_Dir& d) {
  for (const gp_Dir& u : {gp::DZ(), gp::DY(), gp::DX()}) {
    const double c = d.Dot(u);
    if (std::abs(c) > 1e-9) return c > 0 ? d : d.Reversed();
  }
  return d;
}

/// Automatic pull direction, shared by the faces to draft: perpendicular to the planar walls, along the axis of the
/// cylinders and cones. Walls all parallel: the vertical (Z, else Y, else X), or else the normal of a planar face next
/// to them. Turned upward.
gp_Dir autoPull(const std::vector<TopoDS_Shape>& faces, const TopoDS_Shape& body) {
  std::vector<gp_Dir> normals, axes;
  for (const TopoDS_Shape& f : faces) {
    BRepAdaptor_Surface s(TopoDS::Face(f), false);
    switch (s.GetType()) {
      case GeomAbs_Plane: normals.push_back(s.Plane().Axis().Direction()); break;
      case GeomAbs_Cylinder: axes.push_back(s.Cylinder().Axis().Direction()); break;
      case GeomAbs_Cone: axes.push_back(s.Cone().Axis().Direction()); break;
      case GeomAbs_SurfaceOfRevolution: axes.push_back(s.AxeOfRevolution().Direction()); break;
      case GeomAbs_SurfaceOfExtrusion: axes.push_back(s.Direction()); break;
      default: throw FeatureError("Direction de démoulage introuvable sur une face libre : choisissez la face neutre ou un plan");
    }
  }
  const auto fits = [&](const gp_Dir& d) {
    return std::all_of(normals.begin(), normals.end(), [&](const gp_Dir& n) { return std::abs(n.Dot(d)) < 1e-6; }) &&
           std::all_of(axes.begin(), axes.end(), [&](const gp_Dir& a) { return a.IsParallel(d, 1e-6); });
  };
  std::vector<gp_Dir> candidates;
  if (!axes.empty()) candidates.push_back(axes.front());
  for (size_t i = 0; i < normals.size() && candidates.empty(); i++)
    for (size_t j = i + 1; j < normals.size(); j++) {
      const gp_Vec c = gp_Vec(normals[i]).Crossed(gp_Vec(normals[j]));
      if (c.Magnitude() > 1e-6) {
        candidates.emplace_back(c);
        break;
      }
    }
  if (candidates.empty()) {
    candidates = {gp::DZ(), gp::DY(), gp::DX()};
    TopTools_IndexedDataMapOfShapeListOfShape owners;
    TopExp::MapShapesAndAncestors(body, TopAbs_EDGE, TopAbs_FACE, owners);
    for (const TopoDS_Shape& f : faces)
      for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next()) {
        const int i = owners.FindIndex(ex.Current());
        if (i == 0) continue;
        for (const TopoDS_Shape& g : owners(i)) {
          BRepAdaptor_Surface s(TopoDS::Face(g), false);
          if (s.GetType() == GeomAbs_Plane) candidates.push_back(s.Plane().Axis().Direction());
        }
      }
  }
  for (const gp_Dir& d : candidates)
    if (fits(d)) return upward(d);
  throw FeatureError("Les faces n'ont pas de direction de démoulage commune : choisissez la face neutre ou un plan");
}

/// Lowest and highest heights of a face along `d` (its edges, sampled).
std::pair<double, double> extent(const TopoDS_Face& f, const gp_Dir& d) {
  double lo = std::numeric_limits<double>::max(), hi = -lo;
  for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next()) {
    const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
    if (BRep_Tool::Degenerated(e)) continue;
    BRepAdaptor_Curve c(e);
    for (int i = 0; i <= 16; i++) {
      const double h = c.Value(c.FirstParameter() + (c.LastParameter() - c.FirstParameter()) * i / 16).XYZ().Dot(d.XYZ());
      lo = std::min(lo, h);
      hi = std::max(hi, h);
    }
  }
  if (lo > hi) throw FeatureError("Une face à dépouiller n'a pas d'arête");
  return {lo, hi};
}

/// Plane perpendicular to `d` at the height `h`.
gp_Pln planeAt(const gp_Dir& d, double h) { return gp_Pln(gp_Pnt(d.XYZ() * h), d); }

/// Signed distance from the centre of a face to the plane, along its normal.
double side(const TopoDS_Face& f, const gp_Pln& pln) {
  GProp_GProps g;
  BRepGProp::SurfaceProperties(f, g);
  return gp_Vec(pln.Location(), g.CentreOfMass()).Dot(gp_Vec(pln.Axis().Direction()));
}

}  // namespace

FeatureOutput buildDraft(const BuildContext& ctx) {
  const Body* prev = ctx.prev();
  if (!prev) throw FeatureError("Aucun corps à dépouiller");
  const double deg = ctx.num("angle");
  if (deg == 0 || std::abs(deg) >= 90) throw FeatureError("L'angle de dépouille doit être compris entre 0 et 90° (exclus)");
  const double angle = deg * std::numbers::pi / 180;
  const std::vector<TopoDS_Shape> faces = resolveRefs(ctx.feature().refs, *prev, TopAbs_FACE, "faces");
  if (faces.empty()) throw FeatureError("Choisissez les faces à dépouiller");
  const bool parting = ctx.str("mode") == "parting";
  const bool reversed = !parting && ctx.str("reverse") == "yes";
  const bool automatic = ctx.str("neutralFrom") == "auto";
  // Automatic: upward pull direction, parting line in the middle of the faces; the neutral plane of each face is
  // set below.
  gp_Dir up = gp::DZ();
  double lo = std::numeric_limits<double>::max(), hi = -lo;
  if (automatic) {
    up = autoPull(faces, prev->shape);
    for (const TopoDS_Shape& f : faces) {
      const auto [a, b] = extent(TopoDS::Face(f), up);
      lo = std::min(lo, a);
      hi = std::max(hi, b);
    }
  }
  const gp_Pln plane = automatic ? planeAt(up, (lo + hi) / 2) : neutralPlane(ctx, *prev);
  const gp_Dir pull = reversed ? plane.Axis().Direction().Reversed() : plane.Axis().Direction();

  TopTools_ListOfShape args;
  args.Append(prev->shape);
  BRepTools_History history;
  TopoDS_Shape shape = prev->shape;
  // Faces to draft in `shape`, with the pull direction and the neutral plane of each.
  struct Todo {
    TopoDS_Face face;
    gp_Dir pull;
    gp_Pln plane;
  };
  std::vector<Todo> todo;
  if (!parting) {
    for (const TopoDS_Shape& f : faces) {
      const TopoDS_Face face = TopoDS::Face(f);
      if (!automatic) {
        todo.push_back({face, pull, plane});
        continue;
      }
      // Automatic: the face keeps its size at its base (at its top if reversed), the part narrows away from it.
      const auto [a, b] = extent(face, up);
      todo.push_back({face, pull, planeAt(up, reversed ? b : a)});
    }
  } else {
    // Parting line: section of each face by the plane, edges that split the faces of the body (general fuse).
    TopTools_ListOfShape edges;
    for (const TopoDS_Shape& f : faces) {
      BRepAlgoAPI_Section section(f, plane, false);
      section.Approximation(true);
      section.Build();
      if (!section.IsDone()) throw FeatureError("Le plan de joint n'a pas pu couper une face");
      for (TopExp_Explorer ex(section.Shape(), TopAbs_EDGE); ex.More(); ex.Next()) edges.Append(ex.Current());
    }
    const bool cut = !edges.IsEmpty();
    if (cut) {
      BRepAlgoAPI_Splitter split;
      split.SetArguments(args);
      split.SetTools(edges);
      split.Build();
      if (!split.IsDone() || split.HasErrors()) throw FeatureError("La découpe des faces par le plan de joint a échoué");
      const std::vector<TopoDS_Shape> solids = surf::solidsOf(split.Shape());
      if (solids.size() != 1) throw FeatureError("La découpe des faces par le plan de joint a échoué");
      shape = solids.front();
      TopTools_ListOfShape all = args;
      all.Append(edges);
      history = BRepTools_History(all, split);
    }
    for (const TopoDS_Shape& f : faces) {
      TopTools_ListOfShape pieces;
      if (cut && history.IsRemoved(f)) continue;
      if (cut && !history.Modified(f).IsEmpty()) pieces = history.Modified(f);
      else pieces.Append(f);
      // Each side narrows away from the parting plane (the reverse would be an undercut: no reverse here).
      for (const TopoDS_Shape& p : pieces) todo.push_back({TopoDS::Face(p), side(TopoDS::Face(p), plane) >= 0 ? pull : pull.Reversed(), plane});
    }
  }

  BRepOffsetAPI_DraftAngle draft(shape);
  for (const Todo& t : todo) {
    draft.Add(t.face, t.pull, angle, t.plane);
    if (!draft.AddDone())
      throw FeatureError("Une face ne peut pas être dépouillée (parallèle au plan neutre, ou surface non prise en charge)");
  }
  draft.Build();
  if (!draft.IsDone()) throw FeatureError("La dépouille a échoué (angle trop grand, ou faces voisines incompatibles ?)");
  // Every face and edge is modified (tilted or trimmed), none is generated: the history OCCT builds for the draft
  // reports the tilted faces as generated, which would rename them.
  BRepTools_History drafted;
  for (TopAbs_ShapeEnum type : {TopAbs_FACE, TopAbs_EDGE}) {
    TopTools_IndexedMapOfShape subs;
    TopExp::MapShapes(shape, type, subs);
    for (int i = 1; i <= subs.Extent(); i++) {
      const TopoDS_Shape m = draft.ModifiedShape(subs(i));
      if (!m.IsNull() && !m.IsSame(subs(i))) drafted.AddModified(subs(i), m);
    }
  }
  // Histories in a row (split, draft, merge) composed into one: from the body before to the result.
  if (parting) history.Merge(drafted);
  else history = drafted;

  TopoDS_Shape result = draft.Shape();
  if (parting) {
    // The two halves of a split face meet on the parting line: merge what stayed in one piece (faces not tilted).
    ShapeUpgrade_UnifySameDomain unify(result, true, true, false);
    unify.Build();
    result = unify.Shape();
    history.Merge(unify.History());
  }
  const TopoDS_Shape valid = surf::validSolid(result);
  if (valid.IsNull()) throw FeatureError("La dépouille donne un solide invalide");

  Body out;
  out.shape = result;
  out.names = TopoNames::derive(out.shape, {{&prev->shape, &prev->names}}, history,
                                [&](const std::string& origin) { return ctx.name("draft(" + origin + ")"); });
  return out;
}

}  // namespace cad
