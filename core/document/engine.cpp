// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "document/engine.hpp"

#include "io/export.hpp"
#include "part/features.hpp"
#include "part/sheet.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <gp_Circ.hxx>
#include <TopTools_IndexedMapOfShape.hxx>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <cstdio>
#include <exception>

namespace cad {
namespace {

/// FNV-1a 64 bits: short cache keys (the cache is in memory, stability across platforms does not matter).
std::string hash(std::string_view s) {
  uint64_t h = 0xcbf29ce484222325ull;
  for (unsigned char c : s) {
    h ^= c;
    h *= 0x100000001b3ull;
  }
  char buf[17];
  std::snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(h));
  return buf;
}

}  // namespace

std::string describeCurrentException() {
  try {
    throw;
  } catch (const FeatureError& e) {
    return e.what();
  } catch (const Standard_Failure& e) {
    const std::string type = e.DynamicType()->Name();
    const char* msg = e.GetMessageString();
    return msg && *msg ? std::string(msg) + " (" + type + ")" : type;
  } catch (const std::exception& e) {
    return e.what();
  } catch (...) {
    return "Erreur inconnue du noyau";
  }
}

namespace {

/// Projected edges for a sketch: each GeomRef resolved on the current body, described by its end points, its
/// midpoint and its supporting circle; the client projects them onto the sketch plane (deferred preparation, core/CONCEPTION.md).
Json projectedEdges(const Json& refs, const Body* body) {
  if (!body) throw FeatureError("Arêtes projetées : aucun corps de référence");
  auto xyz = [](const gp_Pnt& p) { return Json::array({p.X(), p.Y(), p.Z()}); };
  Json out = Json::array();
  for (const Json& r : refs) {
    Json ref = r.at("ref");
    ref["kind"] = "edge";
    const std::vector<TopoDS_Shape> found = resolveRefs(Json::array({ref}), *body, TopAbs_EDGE);
    const BRepAdaptor_Curve ad(TopoDS::Edge(found.front()));
    const double u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    Json e = {{"id", r.at("id")}, {"first", xyz(ad.Value(u0))}, {"last", xyz(ad.Value(u1))}, {"mid", xyz(ad.Value((u0 + u1) / 2))}};
    if (ad.GetType() == GeomAbs_Circle) {
      const gp_Circ c = ad.Circle();
      e["circle"] = {{"c", xyz(c.Location())}, {"r", c.Radius()}};
    }
    out.push_back(std::move(e));
  }
  return out;
}

}  // namespace

FeatureInput Engine::complete(const FeatureInput& f, const Body* prev, const Resolver& resolver) {
  if (!resolver) throw FeatureError("Préparation différée non prise en charge par ce noyau (arêtes projetées)");
  Json payload = Json::object();
  if (const auto edges = f.deferred.find("edges"); edges != f.deferred.end()) payload["edges"] = projectedEdges(*edges, prev);
  const Json r = resolver(f.id, payload);
  if (const auto e = r.find("error"); e != r.end()) throw FeatureError(e->get<std::string>());
  FeatureInput out = f;
  if (const auto s = r.find("sketch"); s != r.end()) out.sketch = *s;
  if (const auto p = r.find("prepared"); p != r.end()) out.prepared = *p;
  return out;
}

std::vector<FeatureInput> parseFeatures(const Json& features) {
  std::vector<FeatureInput> out;
  out.reserve(features.size());
  for (const Json& f : features) {
    FeatureInput in;
    in.id = f.at("id").get<std::string>();
    in.type = f.at("type").get<std::string>();
    in.suppressed = f.value("suppressed", false);
    if (const auto it = f.find("params"); it != f.end())
      for (const auto& [k, v] : it->items()) in.params.exprs[k] = v.is_string() ? v.get<std::string>() : v.dump();
    if (const auto it = f.find("values"); it != f.end())
      for (const auto& [k, v] : it->items())
        if (v.is_number()) in.params.values[k] = v.get<double>();
    if (const auto it = f.find("errors"); it != f.end())
      for (const auto& [k, v] : it->items()) in.params.errors[k] = v.get<std::string>();
    if (const auto it = f.find("sketch"); it != f.end()) in.sketch = *it;
    if (const auto it = f.find("refs"); it != f.end()) in.refs = *it;
    if (const auto it = f.find("prepared"); it != f.end()) in.prepared = *it;
    if (const auto it = f.find("imported"); it != f.end()) in.imported = *it;
    if (const auto it = f.find("deferred"); it != f.end()) in.deferred = *it;
    in.error = f.value("error", "");
    in.body = f.value("body", "");
    Json canonical = f;
    canonical.erase("suppressed");
    // Imported file: its fingerprint is sufficient (the file is not hashed on every recompute).
    if (canonical.contains("imported")) canonical["imported"] = in.imported.value("hash", "");
    in.canonical = canonical.dump();
    out.push_back(std::move(in));
  }
  return out;
}

Json RecomputeOutput::toJson() const {
  Json j;
  Json st = Json::array();
  for (const FeatureStatus& s : statuses) {
    Json o = {{"id", s.id}, {"ok", s.ok}};
    if (!s.ok) o["error"] = s.error;
    st.push_back(std::move(o));
  }
  j["statuses"] = std::move(st);
  if (mass) {
    j["mass"] = {{"volume", mass->volume}, {"area", mass->area}, {"center", {mass->center[0], mass->center[1], mass->center[2]}}};
    if (const auto& i = mass->inertia)
      j["mass"]["inertia"] = {{"xx", i->xx}, {"yy", i->yy}, {"zz", i->zz}, {"xy", i->xy}, {"xz", i->xz}, {"yz", i->yz}};
  } else
    j["mass"] = nullptr;
  j["rebuilt"] = rebuilt;
  j["ms"] = ms;
  if (!bodyMass.empty() && mass) {
    Json bm = Json::array();
    for (const auto& [id, m] : bodyMass)
      bm.push_back({{"id", id}, {"volume", m.volume}, {"area", m.area}, {"center", {m.center[0], m.center[1], m.center[2]}}});
    j["mass"]["bodies"] = std::move(bm);
  }
  j["timings"] = {{"features", timings.features}, {"mesh", timings.mesh}, {"mass", timings.mass}, {"names", timings.names}};
  j["topology"] = {{"faces", faceNames}, {"edges", edgeNames}};
  Json mb = Json::array();
  for (const MeshedBody& b : bodies) {
    Json e = {{"id", b.id}, {"faces", {b.faceStart, b.faceCount}}, {"edges", {b.edgeStart, b.edgeCount}},
              {"kind", b.kind == BodyKind::Surface ? "surface" : "solid"}};
    if (b.consumed) e["consumed"] = true;
    mb.push_back(std::move(e));
  }
  j["bodies"] = std::move(mb);
  j["freeEdges"] = freeEdges;
  j["activeBody"] = activeBody;
  j["partBodies"] = partBodies;
  if (bodiesBefore) j["bodiesBefore"] = {{"bodies", bodiesBefore->bodies}, {"active", bodiesBefore->active}};
  return j;
}

Engine::Engine() { registerPartFeatures(registry_); }

const Body* Engine::current(std::string_view docId) const {
  const auto it = docs_.find(std::string(docId));
  if (it == docs_.end()) return nullptr;
  for (const BodyEntry& b : it->second.bodies)
    if (b.id == it->second.active) return b.body.get();
  return nullptr;
}

namespace {

/// Shape of a set of bodies: that of the single body (identical to the single-body part before multi-body support), or
/// a compound, in creation order. `keep` filters the bodies retained.
template <class Entries, class Keep>
std::optional<TopoDS_Shape> shapeOf(const Entries& bodies, Keep keep) {
  std::vector<TopoDS_Shape> shapes;
  for (const auto& b : bodies)
    if (keep(b)) shapes.push_back(b.body->shape);
  if (shapes.empty()) return std::nullopt;
  if (shapes.size() == 1) return shapes.front();
  return compoundOf(shapes);
}

template <class Entries>
std::optional<TopoDS_Shape> shapeOf(const Entries& bodies) {
  return shapeOf(bodies, [](const auto&) { return true; });
}

/// Bodies of the part as seen from outside: non-consumed solids.
constexpr auto partSolid = [](const auto& b) { return b.solid() && !b.consumed; };
/// Exported bodies: non-consumed solids and surfaces.
constexpr auto notConsumed = [](const auto& b) { return !b.consumed; };

int count(const TopoDS_Shape& shape, TopAbs_ShapeEnum type) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, type, map);
  return map.Extent();
}

}  // namespace

std::optional<TopoDS_Shape> Engine::partShape(std::string_view docId) const {
  const auto it = docs_.find(std::string(docId));
  if (it == docs_.end()) return std::nullopt;
  return shapeOf(it->second.bodies, partSolid);
}

void Engine::forget(std::string_view docId) {
  const std::string id(docId);
  docs_.erase(id);
  std::erase(recent_, id);
  if (lastDoc_ == id) lastDoc_ = recent_.empty() ? std::string() : recent_.back();
}

void Engine::trim() {
  while (recent_.size() > maxCachedDocs) forget(std::string(recent_.front()));
}

RecomputeOutput Engine::recompute(const Json& input, const Resolver& resolver) {
  const auto t0 = std::chrono::steady_clock::now();
  RecomputeOutput out;
  const std::vector<FeatureInput> features = parseFeatures(input.at("features"));
  const size_t rollback = input.value("rollback", features.size());
  const std::string docId = input.value("docId", "");
  DocState& doc = docs_[docId];
  // Show the bodies as they are BEFORE this function, while computing the full tree.
  const std::string meshBefore = input.value("meshBefore", "");
  // Record the bodies as they are BEFORE this function (those it can target while being edited).
  const std::string bodiesBefore = input.value("bodiesBefore", "");

  std::unordered_map<std::string, OutputPtr> used;
  std::unordered_map<std::string, const SketchProfile*> sketches;
  auto lookup = [&](std::string_view id) -> const SketchProfile* {
    auto it = sketches.find(std::string(id));
    return it == sketches.end() ? nullptr : it->second;
  };
  std::unordered_map<std::string, std::shared_ptr<const Tool>> tools;
  auto toolOf = [&](std::string_view id) -> std::shared_ptr<const Tool> {
    auto it = tools.find(std::string(id));
    return it == tools.end() ? nullptr : it->second;
  };
  std::string key = hash(input.contains("scope") ? input.at("scope").dump() : "[]");
  // Bodies of the part, in creation order, and the active body (last created or modified): default target.
  std::vector<BodyEntry> bodies;
  std::string active;
  std::optional<std::vector<BodyEntry>> shown;
  // Sheet metal: last sheet state left by a feature (flat pattern of the part).
  std::shared_ptr<const SheetState> sheet;
  auto indexOf = [&](std::string_view id) -> std::ptrdiff_t {
    for (size_t k = 0; k < bodies.size(); k++)
      if (bodies[k].id == id) return static_cast<std::ptrdiff_t>(k);
    return -1;
  };
  // Fallback active body: the last solid, "" if there is none.
  auto lastSolid = [&]() -> std::string {
    for (auto it = bodies.rbegin(); it != bodies.rend(); ++it)
      if (it->solid()) return it->id;
    return {};
  };

  for (size_t i = 0; i < features.size(); i++) {
    const FeatureInput& f = features[i];
    if (i >= rollback || f.suppressed) continue;
    if (!meshBefore.empty() && f.id == meshBefore) shown = bodies;
    if (!bodiesBefore.empty() && f.id == bodiesBefore) {
      out.bodiesBefore.emplace();
      for (const BodyEntry& b : bodies) out.bodiesBefore->bodies.push_back(b.id);
      out.bodiesBefore->active = active;
    }
    // Reference plane: resolved by the client, no shape; its frame enters the key of the rest of the tree.
    if (f.type == "plane") {
      key = hash(key + f.type + f.prepared.dump());
      out.statuses.push_back({f.id, f.error.empty(), f.error});
      continue;
    }
    key = hash(key + f.type + f.canonical);
    OutputPtr result;
    if (auto it = doc.cache.find(key); it != doc.cache.end())
      result = it->second;
    else if (auto it2 = used.find(key); it2 != used.end())
      result = it2->second;
    try {
      // Target body: the one designated by the feature, otherwise the active body.
      const std::ptrdiff_t target = indexOf(f.body.empty() ? active : f.body);
      if (!f.body.empty() && target < 0) throw FeatureError("Corps introuvable");
      if (target >= 0 && !bodies[target].solid() && registry_.target(f.type) == TargetKind::Solid)
        throw FeatureError("Le corps cible est une surface : choisissez un corps solide");
      if (!result) {
        if (!f.error.empty()) throw FeatureError(f.error);
        const FeatureBuilder* builder = registry_.find(f.type);
        if (!builder) throw FeatureError("Fonction inconnue « " + f.type + " »");
        const Body* prevBody = target >= 0 ? bodies[target].body.get() : nullptr;
        BodyList list;
        for (const BodyEntry& b : bodies) list.emplace_back(b.id, b.body.get());
        // Deferred preparation: the client completes the feature with data from the current body.
        FeatureInput completed;
        const FeatureInput* input = &f;
        if (!f.deferred.is_null()) {
          completed = complete(f, prevBody, resolver);
          input = &completed;
        }
        const BuildContext ctx(*input, prevBody, lookup, toolOf, target >= 0 ? bodies[target].sheet.get() : nullptr, &list,
                               target >= 0 ? bodies[target].id : std::string());
        FeatureOutput built = (*builder)(ctx);
        // Part feature that removes material from a sheet (hole, extruded cut…): carried over into the flat pattern,
        // like a sheet-metal cut.
        if (Body* b = std::get_if<Body>(&built); b && ctx.sheet() && !b->sheet && !b->created && b->tool && b->tool->cut)
          b->sheet = std::make_shared<const SheetState>(sheetAfterCut(*ctx.sheet(), b->tool->shape));
        result = std::make_shared<const FeatureOutput>(std::move(built));
        out.rebuilt++;
      }
      used[key] = result;
      if (const Body* body = std::get_if<Body>(result.get())) {
        std::shared_ptr<const Body> ptr(result, body);
        if (body->tool) tools[f.id] = body->tool;
        if (body->sheet) sheet = body->sheet;
        // The active body is the last solid created or modified: a surface does not become the default target.
        if (target < 0 || body->created) {
          bodies.push_back({f.id, ptr, body->sheet});
          if (body->kind == BodyKind::Solid) active = f.id;
        } else {
          bodies[target].body = ptr;
          if (body->sheet) bodies[target].sheet = body->sheet;
          if (body->kind == BodyKind::Solid) active = bodies[target].id;
        }
      } else if (const BodyChanges* c = std::get_if<BodyChanges>(result.get())) {
        if (target < 0 && (c->target || c->removeTarget)) throw FeatureError("Aucun corps");
        const std::string targetId = target >= 0 ? bodies[target].id : std::string();
        if (c->target) {
          bodies[target].body = std::shared_ptr<const Body>(result, &*c->target);
          if (c->target->tool) tools[f.id] = c->target->tool;
        }
        if (!c->created.empty() && c->created.front().tool) tools[f.id] = c->created.front().tool;
        for (size_t k = 0; k < c->created.size(); k++)
          bodies.push_back({k == 0 ? f.id : f.id + "#" + std::to_string(k + 1), std::shared_ptr<const Body>(result, &c->created[k]), nullptr});
        std::erase_if(bodies, [&](const BodyEntry& b) {
          return (c->removeTarget && b.id == targetId) || std::find(c->removed.begin(), c->removed.end(), b.id) != c->removed.end();
        });
        for (BodyEntry& b : bodies)
          if (std::find(c->consumed.begin(), c->consumed.end(), b.id) != c->consumed.end()) b.consumed = true;
        // Active body: the target if it is still a solid, otherwise the first created solid, otherwise the last solid.
        if (const std::ptrdiff_t t = indexOf(targetId); t >= 0 && bodies[t].solid())
          active = targetId;
        else if (const auto s = std::find_if(c->created.begin(), c->created.end(), [](const Body& b) { return b.kind == BodyKind::Solid; });
                 s != c->created.end())
          active = s == c->created.begin() ? f.id : f.id + "#" + std::to_string(s - c->created.begin() + 1);
        else if (indexOf(active) < 0 || !bodies[indexOf(active)].solid())
          active = lastSolid();
      } else
        sketches[f.id] = &std::get<SketchProfile>(*result);
      out.statuses.push_back({f.id, true, {}});
    } catch (...) {
      // The feature in error is skipped: the rest of the tree restarts from the last valid state.
      out.statuses.push_back({f.id, false, describeCurrentException()});
    }
  }

  doc.cache = std::move(used);
  doc.bodies = bodies;
  doc.active = active;
  doc.sheet = sheet;
  out.activeBody = active;
  for (const BodyEntry& b : bodies) out.partBodies.push_back(b.id);
  lastDoc_ = docId;
  std::erase(recent_, docId);
  recent_.push_back(docId);

  auto lap = [last = std::chrono::steady_clock::now()]() mutable {
    const auto now = std::chrono::steady_clock::now();
    const double ms = std::chrono::duration<double, std::milli>(now - last).count();
    last = now;
    return ms;
  };
  out.timings.features = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  // Mesh and names: displayed bodies (meshBefore); mass properties: final bodies.
  const std::vector<BodyEntry>& display = shown ? *shown : bodies;
  mesh_.clear();
  try {
    // Body by body: the identifiers of faces and edges follow the names below (bodies may share sub-shapes).
    if (!display.empty()) {
      std::vector<TopoDS_Shape> shapes;
      for (const BodyEntry& b : display) shapes.push_back(b.body->shape);
      tessellateBodies(shapes, meshOptions, mesh_);
      out.timings.mesh = lap();
    }
    // Mass: solids of the part; a part without solids gives the area of its surfaces.
    if (const std::optional<TopoDS_Shape> shape = shapeOf(bodies, partSolid))
      out.mass = massProperties(*shape);
    else if (const std::optional<TopoDS_Shape> surfaces = shapeOf(bodies, notConsumed))
      out.mass = surfaceProperties(*surfaces);
    if (out.mass) {
      const bool surface = std::any_of(bodies.begin(), bodies.end(), [](const BodyEntry& b) { return !b.solid(); });
      if (bodies.size() > 1 || surface)
        for (const BodyEntry& b : bodies)
          out.bodyMass.emplace_back(b.id, b.solid() ? massProperties(b.body->shape) : surfaceProperties(b.body->shape));
      out.timings.mass = lap();
    }
    int faces = 0, edges = 0;
    for (const BodyEntry& b : display) {
      const std::vector<std::string> fn = b.body->names.faceNames(b.body->shape);
      const std::vector<std::string> en = b.body->names.edgeNames(b.body->shape);
      out.bodies.push_back({b.id, faces, static_cast<int>(fn.size()), edges, static_cast<int>(en.size()), b.body->kind, b.consumed});
      // A solid has no free edge: they are only searched for on surfaces.
      if (!b.solid()) {
        const std::vector<bool> free = TopoNames::freeEdges(b.body->shape);
        for (size_t k = 0; k < free.size(); k++)
          if (free[k]) out.freeEdges.push_back(edges + static_cast<int>(k));
      }
      faces += static_cast<int>(fn.size());
      edges += static_cast<int>(en.size());
      out.faceNames.insert(out.faceNames.end(), fn.begin(), fn.end());
      out.edgeNames.insert(out.edgeNames.end(), en.begin(), en.end());
    }
    if (!display.empty()) out.timings.names = lap();
  } catch (...) {
    mesh_.clear();
    out.mass.reset();
    out.bodyMass.clear();
    out.freeEdges.clear();
  }
  out.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return out;
}

std::string Engine::recomputeJson(std::string_view input, const Resolver& resolver) {
  return recompute(Json::parse(input), resolver).toJson().dump();
}

int Engine::resolveName(std::string_view name, std::string_view docId) const {
  const auto it = docs_.find(std::string(docId));
  if (it == docs_.end()) return -1;
  // Mesh identifiers contiguous per body, in creation order (see RecomputeOutput::bodies).
  int offset = 0;
  for (const BodyEntry& b : it->second.bodies) {
    const TopoDS_Shape& shape = b.body->shape;
    if (const std::optional<TopoDS_Shape> found = b.body->names.find(shape, name)) {
      TopTools_IndexedMapOfShape map;
      TopExp::MapShapes(shape, found->ShapeType(), map);
      return offset + map.FindIndex(*found) - 1;
    }
    // The name is not in this body: offset by its number of faces or edges (depending on the designated type).
    offset += count(shape, name.starts_with("e(") ? TopAbs_EDGE : name.starts_with("v(") ? TopAbs_VERTEX : TopAbs_FACE);
  }
  return -1;
}

std::vector<float> Engine::surfaceAnalysis(std::string_view docId, std::string_view kind) const {
  const auto it = docs_.find(std::string(docId));
  const std::optional<TopoDS_Shape> shape = it == docs_.end() ? std::nullopt : shapeOf(it->second.bodies);
  if (!shape) throw std::runtime_error("Aucune géométrie à analyser");
  return curvatureAtNodes(*shape, curvatureKind(kind));
}

std::vector<ContinuitySample> Engine::continuity(std::string_view docId, std::string_view edgeName) const {
  const auto it = docs_.find(std::string(docId));
  if (it == docs_.end()) throw std::runtime_error("Aucune géométrie à analyser");
  for (const BodyEntry& b : it->second.bodies)
    if (const std::optional<TopoDS_Shape> found = b.body->names.find(b.body->shape, edgeName); found && found->ShapeType() == TopAbs_EDGE)
      return edgeContinuity(b.body->shape, TopoDS::Edge(*found));
  throw std::runtime_error("Arête introuvable : désignez-la à nouveau");
}

MeshData Engine::camMesh(std::string_view docId, double deflection) const {
  const std::optional<TopoDS_Shape> shape = partShape(docId);
  if (!shape) throw std::runtime_error("Aucune géométrie à mailler");
  MeshOptions options;
  options.deflection = deflection;
  // Tight angular deflection: curved surfaces stay faithful to the drop-cutter.
  options.angularDeflection = 0.1;
  MeshData out;
  tessellate(*shape, options, out);
  // The fine triangulation is attached to the shape (shared with the cache): it is removed so that the display
  // keeps its normal mesh at the next recompute.
  BRepTools::Clean(*shape);
  return out;
}

std::vector<uint8_t> Engine::exportShape(std::string_view format, std::string_view docId) const {
  const auto it = docs_.find(std::string(docId));
  const std::optional<TopoDS_Shape> shape = it == docs_.end() ? std::nullopt : shapeOf(it->second.bodies, notConsumed);
  if (!shape) throw std::runtime_error("Aucune géométrie à exporter");
  return cad::exportShape(*shape, format);
}

namespace {

gp_Trsf placement(const std::array<double, 16>& m) {
  gp_Trsf t;
  t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
  return t;
}

/// Maximum distance between `from` and the bounding box of `shape` (0 if empty).
double reach(const TopoDS_Shape& shape, const gp_Pnt& from) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box, false);
  if (box.IsVoid()) return 0;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  auto farthest = [](double a, double b, double p) { return std::max(std::abs(a - p), std::abs(b - p)); };
  return std::hypot(farthest(x0, x1, from.X()), farthest(y0, y1, from.Y()), farthest(z0, z1, from.Z()));
}

}  // namespace

FlatPatternData Engine::flatPattern(std::string_view docId) const {
  const auto it = docs_.find(std::string(docId));
  if (it == docs_.end() || !it->second.sheet) throw std::runtime_error("La pièce n'est pas une tôle (aucune tôle de base valide)");
  return cad::flatPattern(*it->second.sheet);
}

std::vector<uint8_t> Engine::exportPlaced(std::string_view format, const std::vector<Placed>& parts) const {
  std::vector<TopoDS_Shape> shapes;
  for (const Placed& p : parts) {
    const std::optional<TopoDS_Shape> shape = partShape(p.docId);
    if (!shape) continue;
    shapes.push_back(BRepBuilderAPI_Transform(*shape, placement(p.matrix), true, false).Shape());
  }
  if (shapes.empty()) throw std::runtime_error("Aucune géométrie à exporter");
  return cad::exportShape(compoundOf(shapes), format);
}

std::vector<Engine::Interference> Engine::interferences(const std::vector<Placed>& parts, double minVolume) const {
  struct Item {
    std::string key;
    TopoDS_Shape shape;
    Bnd_Box box;
  };
  std::vector<Item> placed;
  for (const Placed& p : parts) {
    const std::optional<TopoDS_Shape> shape = partShape(p.docId);
    if (!shape) continue;
    Item it{p.key, BRepBuilderAPI_Transform(*shape, placement(p.matrix), true, false).Shape(), {}};
    BRepBndLib::Add(it.shape, it.box, false);
    placed.push_back(std::move(it));
  }
  std::vector<Interference> out;
  for (size_t i = 0; i < placed.size(); i++) {
    for (size_t j = i + 1; j < placed.size(); j++) {
      if (placed[i].box.IsOut(placed[j].box)) continue;
      BRepAlgoAPI_Common common(placed[i].shape, placed[j].shape);
      if (!common.IsDone()) continue;
      GProp_GProps g;
      BRepGProp::VolumeProperties(common.Shape(), g, false, false, false);
      if (g.Mass() > minVolume) out.push_back({placed[i].key, placed[j].key, g.Mass()});
    }
  }
  return out;
}

std::vector<Engine::SceneResult> Engine::projectScene(const std::vector<Placed>& items, const std::vector<SceneView>& views) const {
  std::vector<std::pair<const Placed*, TopoDS_Shape>> placed;
  for (const Placed& it : items) {
    const std::optional<TopoDS_Shape> shape = partShape(it.docId);
    if (!shape) continue;
    placed.emplace_back(&it, BRepBuilderAPI_Transform(*shape, placement(it.matrix), true, false).Shape());
  }
  if (placed.empty()) throw std::runtime_error("Aucune pièce avec un volume à projeter");
  std::vector<TopoDS_Shape> shapes;
  for (const auto& p : placed) shapes.push_back(p.second);
  const TopoDS_Compound all = compoundOf(shapes);
  const double size = reach(all, gp::Origin());
  std::vector<SceneResult> results;
  for (const SceneView& v : views) {
    SceneResult r;
    if (!v.section) {
      r.view = projectShape(all, v.kind);
      results.push_back(std::move(r));
      continue;
    }
    const gp_Dir n = viewAxes(v.kind).n;
    std::vector<TopoDS_Shape> kept;
    for (const auto& [item, shape] : placed) {
      if (!item->cut) {
        // Part not cut: kept whole unless it lies entirely in front of the plane.
        Bnd_Box box;
        BRepBndLib::Add(shape, box, false);
        double x[2], y[2], z[2];
        box.Get(x[0], y[0], z[0], x[1], y[1], z[1]);
        double lowest = std::numeric_limits<double>::infinity();
        for (double cx : x)
          for (double cy : y)
            for (double cz : z) lowest = std::min(lowest, cx * n.X() + cy * n.Y() + cz * n.Z());
        if (lowest <= *v.section) kept.push_back(shape);
        continue;
      }
      Section s = sectionShape(shape, v.kind, *v.section, size);
      kept.push_back(s.kept);
      if (!s.segments.empty()) r.hatches.emplace_back(item->key, std::move(s.segments));
    }
    r.view = projectShape(compoundOf(kept), v.kind);
    // The section outlines are part of the visible edges.
    for (const auto& h : r.hatches) r.view.visible.insert(r.view.visible.end(), h.second.begin(), h.second.end());
    results.push_back(std::move(r));
  }
  return results;
}

}  // namespace cad
