// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Planar surface and fill surface: a new surface body closing a planar outline, or an N-sided patch bounded by
// edges of the part, tangent (G1) to the faces along them if asked. The source bodies are copied first: OCCT adds
// curves to the edges it is given, the cached bodies must not change. Naming (core/NAMING.md):
//   - planar surface of the region R of a sketch: "<id>/plane(R)", its edge from the curve C "e(<id>/plane(R)|<id>/rim(C))";
//   - planar surface on edges, fill: "<id>/plane", "<id>/fill"; the edge along the designated edge E (topological name
//     of the reference) "e(<id>/fill|<id>/rim(E))", or "rim(<k>)" by its rank if the reference has no name.
#include "part/features.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepOffsetAPI_MakeFilling.hxx>
#include <BRep_Builder.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <ShapeFix_Face.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>

#include <cmath>
#include <map>
#include <numbers>
#include <memory>
#include <string>
#include <vector>

namespace cad {
namespace {

/// Largest deviation (°) accepted between the fill and a support face along a G1 edge.
constexpr double kG1Tolerance = 2;

/// Designated boundary edge: copy of the edge (in a copy of its body), its support face if any, its settings.
struct Boundary {
  TopoDS_Edge edge;
  std::string key;     // naming key: topological name of the reference, or rank
  std::string choice;  // per-element setting (GeomRef.choice)
  std::string body;
};

/// Copies of the bodies used by a feature, made once per body.
class Copies {
public:
  explicit Copies(const BuildContext& ctx) : ctx_(ctx) {}
  /// Sub-shape of the copy of `body` corresponding to `s`.
  TopoDS_Shape of(const std::string& body, const TopoDS_Shape& s) {
    auto it = copies_.find(body);
    if (it == copies_.end()) it = copies_.emplace(body, std::make_unique<BRepBuilderAPI_Copy>(ctx_.body(body).shape)).first;
    return it->second->ModifiedShape(s);
  }
  const TopoDS_Shape& shape(const std::string& body) {
    of(body, ctx_.body(body).shape);
    return copies_.at(body)->Shape();
  }

private:
  const BuildContext& ctx_;
  std::map<std::string, std::unique_ptr<BRepBuilderAPI_Copy>> copies_;
};

/// References of the group `group` (JSON, in order), aligned with resolveGroup.
std::vector<const Json*> groupRefs(const BuildContext& ctx, TopAbs_ShapeEnum kind, std::string_view group) {
  std::vector<const Json*> out;
  const Json& refs = ctx.feature().refs;
  if (!refs.is_array()) return out;
  const char* name = kind == TopAbs_EDGE ? "edge" : "face";
  for (const Json& r : refs)
    if (r.value("kind", "") == name && r.value("group", "") == group) out.push_back(&r);
  return out;
}

/// Designated edges of the group `group`, copied, in the order of the references.
std::vector<Boundary> boundaries(const BuildContext& ctx, Copies& copies, std::string_view group, const std::string& fallback) {
  const std::vector<GroupRef> found = resolveGroup(ctx, TopAbs_EDGE, group);
  const std::vector<const Json*> refs = groupRefs(ctx, TopAbs_EDGE, group);
  std::vector<Boundary> out;
  for (size_t k = 0; k < found.size(); k++) {
    const Json& r = *refs[k];
    const std::string name = r.value("name", "");
    out.push_back({TopoDS::Edge(copies.of(found[k].body, found[k].shape)), name.empty() ? std::to_string(k) : name, r.value("choice", fallback),
                   found[k].body});
  }
  return out;
}

TopoDS_Vertex middle(const TopoDS_Edge& e) {
  BRepAdaptor_Curve c(e);
  return BRepBuilderAPI_MakeVertex(c.Value((c.FirstParameter() + c.LastParameter()) / 2)).Vertex();
}

double distance(const TopoDS_Shape& a, const TopoDS_Shape& b) {
  BRepExtrema_DistShapeShape d(a, b);
  return d.IsDone() ? d.Value() : 1e100;
}

/// Names the edges of `face` lying along the boundaries: "e(<face>|<id>/rim(<key>))".
void nameRims(const BuildContext& ctx, TopoNames& names, const TopoDS_Shape& face, const std::string& faceName, const std::vector<Boundary>& bounds) {
  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes(face, TopAbs_EDGE, edges);
  for (int i = 1; i <= edges.Extent(); i++) {
    const TopoDS_Vertex mid = middle(TopoDS::Edge(edges(i)));
    for (const Boundary& b : bounds)
      if (distance(mid, b.edge) < 1e-3) {
        names.setEdge(edges(i), TopoNames::edgeName({faceName, ctx.name("rim(" + b.key + ")")}));
        break;
      }
  }
}

Body surfaceBody(TopoDS_Shape shape, TopoNames names) {
  Body out;
  out.shape = std::move(shape);
  out.names = std::move(names);
  out.created = true;
  out.kind = BodyKind::Surface;
  return out;
}

/// Single closed wire through the edges (in any order and orientation).
TopoDS_Wire closedWire(const std::vector<Boundary>& bounds, const char* error) {
  Handle(TopTools_HSequenceOfShape) edges = new TopTools_HSequenceOfShape;
  for (const Boundary& b : bounds) edges->Append(b.edge);
  Handle(TopTools_HSequenceOfShape) wires;
  ShapeAnalysis_FreeBounds::ConnectEdgesToWires(edges, 1e-3, false, wires);
  if (wires.IsNull() || wires->Length() != 1 || !TopoDS::Wire(wires->Value(1)).Closed()) throw FeatureError(error);
  return TopoDS::Wire(wires->Value(1));
}

}  // namespace

/// Planar surface: the regions of a sketch (`source` = "sketch"), or the planar closed outline formed by the designated
/// edges (`source` = "edges", group "edges"), for instance the free edge of an open surface.
FeatureOutput buildPlanarSurface(const BuildContext& ctx) {
  TopoNames names;
  if (ctx.str("source") != "edges") {
    const SketchProfile& s = ctx.sketch("sketch");
    if (s.faces.empty()) throw FeatureError("L'esquisse ne contient aucun contour fermé");
    TopoDS_Compound all;
    BRep_Builder b;
    b.MakeCompound(all);
    for (size_t i = 0; i < s.faces.size(); i++) {
      const std::string face = ctx.name("plane(" + s.regionKeys[i] + ")");
      names.set(s.faces[i], face);
      for (TopExp_Explorer ex(s.faces[i], TopAbs_EDGE); ex.More(); ex.Next())
        if (const auto c = s.edgeCurves.find(ex.Current()); c != s.edgeCurves.end())
          names.setEdge(ex.Current(), TopoNames::edgeName({face, ctx.name("rim(" + c->second + ")")}));
      b.Add(all, s.faces[i]);
    }
    return surfaceBody(all, std::move(names));
  }
  Copies copies(ctx);
  const std::vector<Boundary> bounds = boundaries(ctx, copies, "edges", "");
  if (bounds.empty()) throw FeatureError("Désignez les arêtes du contour à fermer");
  const TopoDS_Wire wire = closedWire(bounds, "Les arêtes désignées ne forment pas un seul contour fermé");
  BRepBuilderAPI_MakeFace mk(wire, true);
  if (!mk.IsDone()) throw FeatureError("Les arêtes désignées ne sont pas dans un même plan : utilisez le remplissage");
  ShapeFix_Face fix(mk.Face());
  fix.Perform();
  const TopoDS_Face face = fix.Face();
  if (!BRepCheck_Analyzer(face, true).IsValid()) throw FeatureError("Surface plane invalide (contour qui se recoupe ?)");
  const std::string name = ctx.name("plane");
  names.set(face, name);
  nameRims(ctx, names, face, name, bounds);
  return surfaceBody(face, std::move(names));
}

/// Fill surface: patch bounded by the designated edges (group "edges", closed contour), each with a continuity
/// (`GeomRef.choice`: "G0" or "G1", default G1) with its support face. Support: the single face of the edge in its
/// body (free edge of a surface), otherwise the designated face of the group "supports" that contains it. Optional
/// points of passage: isolated points of the sketch `points` (`usePoints` = "yes"). `quality`: "normal" or "fine".
FeatureOutput buildFillSurface(const BuildContext& ctx) {
  Copies copies(ctx);
  const std::vector<Boundary> bounds = boundaries(ctx, copies, "edges", "G1");
  if (bounds.empty()) throw FeatureError("Désignez les arêtes du contour à remplir");
  closedWire(bounds, "Les arêtes désignées ne forment pas un seul contour fermé");
  // Designated support faces, in the copies of their bodies.
  std::vector<std::pair<std::string, TopoDS_Face>> supports;
  for (const GroupRef& g : resolveGroup(ctx, TopAbs_FACE, "supports")) supports.push_back({g.body, TopoDS::Face(copies.of(g.body, g.shape))});

  const bool fine = ctx.str("quality") == "fine";
  // Degree, points per constraint, iterations; maximum degree and segments of the result (bounded: WASM timing).
  BRepOffsetAPI_MakeFilling fill(3, fine ? 20 : 12, fine ? 3 : 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, fine ? 9 : 6);
  // Edges in tangency (G1), by rank.
  std::vector<size_t> tangent;
  try {
    for (size_t k = 0; k < bounds.size(); k++) {
      const Boundary& b = bounds[k];
      if (b.choice == "G0") {
        fill.Add(b.edge, GeomAbs_C0, true);
        continue;
      }
      if (b.choice != "G1") throw FeatureError("Continuité inconnue « " + b.choice + " »");
      TopTools_IndexedDataMapOfShapeListOfShape owners;
      TopExp::MapShapesAndAncestors(copies.shape(b.body), TopAbs_EDGE, TopAbs_FACE, owners);
      TopoDS_Face support;
      for (const auto& [body, f] : supports) {
        if (body != b.body) continue;
        for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More() && support.IsNull(); ex.Next())
          if (ex.Current().IsSame(b.edge)) support = f;
      }
      if (support.IsNull()) {
        const TopTools_ListOfShape* faces = owners.Seek(b.edge);
        if (!faces || faces->Extent() != 1)
          throw FeatureError("Arête entre deux faces : désignez sa face d'appui pour la tangence (G1), ou passez-la en G0");
        support = TopoDS::Face(faces->First());
      }
      fill.Add(b.edge, support, GeomAbs_G1, true);
      tangent.push_back(k);
    }
    if (ctx.str("usePoints") == "yes") {
      const SketchProfile& s = ctx.sketch("points");
      if (s.isolated.empty()) throw FeatureError("L'esquisse des points de passage ne contient aucun point isolé");
      for (const SketchProfile::Point& p : s.isolated) fill.Add(s.toWorld(p.p));
    }
    fill.Build();
  } catch (const Standard_Failure& e) {
    throw FeatureError(std::string("Le remplissage a échoué (") + e.GetMessageString() + ")");
  }
  if (!fill.IsDone()) throw FeatureError("Le remplissage a échoué (contour trop irrégulier ?)");
  // The patch deforms a mean plane of the boundary: it cannot become perpendicular to it. A tangency that is not
  // reached (support face nearly perpendicular to the boundary) is reported rather than silently left out.
  if (!tangent.empty()) {
    const double deg = fill.G1Error() * 180 / std::numbers::pi;
    if (deg > kG1Tolerance)
      throw FeatureError("Tangence (G1) impossible (écart " + std::to_string(int(std::lround(deg))) +
                         "°) : une face d'appui est presque perpendiculaire au contour, passez son arête en G0");
  }
  TopoDS_Shape face;
  for (TopExp_Explorer ex(fill.Shape(), TopAbs_FACE); ex.More(); ex.Next()) face = ex.Current();
  if (face.IsNull() || !BRepCheck_Analyzer(face, true).IsValid()) throw FeatureError("Le remplissage donne une surface invalide");
  TopoNames names;
  const std::string name = ctx.name("fill");
  names.set(face, name);
  nameRims(ctx, names, face, name, bounds);
  return surfaceBody(face, std::move(names));
}

}  // namespace cad
