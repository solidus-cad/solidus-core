// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "naming/naming.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepBndLib.hxx>
#include <BRepTools_History.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>

#include <algorithm>
#include <array>
#include <cmath>
#include <map>

namespace cad {
namespace {

using Key = std::array<double, 3>;

double rounded(double v) { return std::round(v * 1e6) / 1e6; }

/// Deterministic geometric key to tell apart homonyms: centre of the bounding box.
Key boxKey(const TopoDS_Shape& s) {
  Bnd_Box box;
  BRepBndLib::Add(s, box, false);
  if (box.IsVoid()) return {0, 0, 0};
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  return {rounded((x0 + x1) / 2), rounded((y0 + y1) / 2), rounded((z0 + z1) / 2)};
}

/// Midpoint of an edge (more discriminating than the box for two edges between the same faces).
Key edgeKey(const TopoDS_Shape& s) {
  const TopoDS_Edge& e = TopoDS::Edge(s);
  if (BRep_Tool::Degenerated(e)) return boxKey(s);
  BRepAdaptor_Curve c(e);
  gp_Pnt p = c.Value((c.FirstParameter() + c.LastParameter()) / 2);
  return {rounded(p.X()), rounded(p.Y()), rounded(p.Z())};
}

/// Appends "#1", "#2"... to duplicate names, in the order of their geometric key.
void disambiguate(std::vector<std::string>& names, const std::vector<Key>& keys,
                  const std::function<void(size_t index, const std::string& plain)>& onSplit = {}) {
  std::map<std::string, std::vector<size_t>> groups;
  for (size_t i = 0; i < names.size(); i++) groups[names[i]].push_back(i);
  for (auto& [name, idx] : groups) {
    if (idx.size() < 2) continue;
    std::stable_sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return keys[a] < keys[b]; });
    for (size_t k = 0; k < idx.size(); k++) {
      names[idx[k]] = name + "#" + std::to_string(k + 1);
      if (onSplit && k == 0) onSplit(idx[k], name);
    }
  }
}

std::string join(std::vector<std::string> parts, std::string_view prefix) {
  std::sort(parts.begin(), parts.end());
  parts.erase(std::unique(parts.begin(), parts.end()), parts.end());
  std::string out(prefix);
  out += '(';
  for (size_t i = 0; i < parts.size(); i++) {
    if (i) out += '|';
    out += parts[i];
  }
  out += ')';
  return out;
}

}  // namespace

void TopoNames::set(const TopoDS_Shape& face, std::string name) { faces_[face] = Entry{std::move(name), {}}; }

void TopoNames::setEdge(const TopoDS_Shape& edge, std::string name) { edges_[edge] = std::move(name); }

std::string TopoNames::edgeName(std::vector<std::string> faces) { return join(std::move(faces), "e"); }

void TopoNames::addAlias(const TopoDS_Shape& face, std::string alias) {
  auto it = faces_.find(face);
  if (it != faces_.end()) it->second.aliases.push_back(std::move(alias));
}

const std::string* TopoNames::face(const TopoDS_Shape& face) const {
  auto it = faces_.find(face);
  return it == faces_.end() ? nullptr : &it->second.name;
}

std::vector<std::string> TopoNames::faceNames(const TopoDS_Shape& shape) const {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, TopAbs_FACE, map);
  std::vector<std::string> out;
  out.reserve(map.Extent());
  for (int i = 1; i <= map.Extent(); i++) {
    const std::string* n = face(map(i));
    out.push_back(n ? *n : "?");
  }
  return out;
}

static std::vector<std::string> namesByAdjacentFaces(const TopoNames& names, const TopoDS_Shape& shape, TopAbs_ShapeEnum type,
                                                     std::string_view prefix,
                                                     const std::function<const std::string*(const TopoDS_Shape&)>& explicitName = {}) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, type, map);
  TopTools_IndexedDataMapOfShapeListOfShape adjacency;
  TopExp::MapShapesAndUniqueAncestors(shape, type, TopAbs_FACE, adjacency);
  std::vector<std::string> out;
  std::vector<Key> keys;
  out.reserve(map.Extent());
  for (int i = 1; i <= map.Extent(); i++) {
    std::vector<std::string> faces;
    const TopTools_ListOfShape* adj = adjacency.Seek(map(i));
    if (adj) {
      for (const TopoDS_Shape& f : *adj) {
        const std::string* n = names.face(f);
        faces.push_back(n ? *n : "?");
      }
    }
    // Free edge: a single face, and not a seam (a cylinder seam also touches a single face).
    if (type == TopAbs_EDGE && adj && adj->Extent() == 1 && !BRep_Tool::IsClosed(TopoDS::Edge(map(i)), TopoDS::Face(adj->First()))) {
      if (const std::string* n = explicitName ? explicitName(map(i)) : nullptr) {
        out.push_back(*n);
        keys.push_back(edgeKey(map(i)));
        continue;
      }
      faces.push_back("~");
    }
    out.push_back(join(std::move(faces), prefix));
    keys.push_back(type == TopAbs_EDGE ? edgeKey(map(i)) : boxKey(map(i)));
  }
  disambiguate(out, keys);
  return out;
}

std::vector<bool> TopoNames::freeEdges(const TopoDS_Shape& shape) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, TopAbs_EDGE, map);
  TopTools_IndexedDataMapOfShapeListOfShape adjacency;
  TopExp::MapShapesAndUniqueAncestors(shape, TopAbs_EDGE, TopAbs_FACE, adjacency);
  std::vector<bool> out(map.Extent(), false);
  for (int i = 1; i <= map.Extent(); i++) {
    const TopTools_ListOfShape* adj = adjacency.Seek(map(i));
    out[i - 1] = adj && adj->Extent() == 1 && !BRep_Tool::IsClosed(TopoDS::Edge(map(i)), TopoDS::Face(adj->First()));
  }
  return out;
}

std::vector<std::string> TopoNames::edgeNames(const TopoDS_Shape& shape) const {
  return namesByAdjacentFaces(*this, shape, TopAbs_EDGE, "e", [this](const TopoDS_Shape& e) -> const std::string* {
    auto it = edges_.find(e);
    return it == edges_.end() ? nullptr : &it->second;
  });
}

std::vector<std::string> TopoNames::vertexNames(const TopoDS_Shape& shape) const {
  return namesByAdjacentFaces(*this, shape, TopAbs_VERTEX, "v");
}

std::optional<TopoDS_Shape> TopoNames::find(const TopoDS_Shape& shape, std::string_view name) const {
  const bool isEdge = name.substr(0, 2) == "e(";
  const bool isVertex = name.substr(0, 2) == "v(";
  if (isEdge || isVertex) {
    const TopAbs_ShapeEnum type = isEdge ? TopAbs_EDGE : TopAbs_VERTEX;
    std::vector<std::string> names = isEdge ? edgeNames(shape) : vertexNames(shape);
    TopTools_IndexedMapOfShape map;
    TopExp::MapShapes(shape, type, map);
    for (size_t i = 0; i < names.size(); i++)
      if (names[i] == name) return map(int(i) + 1);
    return std::nullopt;
  }
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, TopAbs_FACE, map);
  std::optional<TopoDS_Shape> byAlias;
  for (int i = 1; i <= map.Extent(); i++) {
    auto it = faces_.find(map(i));
    if (it == faces_.end()) continue;
    if (it->second.name == name) return map(i);
    if (!byAlias && std::find(it->second.aliases.begin(), it->second.aliases.end(), name) != it->second.aliases.end())
      byAlias = map(i);
  }
  return byAlias;
}

TopoNames TopoNames::derive(const TopoDS_Shape& result, const std::vector<Input>& inputs, const BRepTools_History& history,
                            const GeneratedNamer& generated) {
  TopTools_IndexedMapOfShape resultFaces;
  TopExp::MapShapes(result, TopAbs_FACE, resultFaces);
  const int n = resultFaces.Extent();
  struct Candidates {
    std::vector<std::string> primary;
    std::vector<std::string> aliases;
  };
  std::vector<Candidates> cands(n);

  // 1. Faces kept or modified: they inherit the name (and aliases) of their origin.
  for (const Input& in : inputs) {
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(*in.shape, TopAbs_FACE, faces);
    for (int i = 1; i <= faces.Extent(); i++) {
      const TopoDS_Shape& f = faces(i);
      auto it = in.names->faces_.find(f);
      if (it == in.names->faces_.end() || history.IsRemoved(f)) continue;
      auto add = [&](const TopoDS_Shape& s) {
        const int idx = resultFaces.FindIndex(s);
        if (idx == 0) return;
        cands[idx - 1].primary.push_back(it->second.name);
        for (const std::string& a : it->second.aliases) cands[idx - 1].aliases.push_back(a);
      };
      const TopTools_ListOfShape& modified = history.Modified(f);
      if (modified.IsEmpty()) {
        add(f);
      } else {
        for (const TopoDS_Shape& m : modified) add(m);
      }
    }
  }

  // 2. Faces generated by an edge, a vertex or a face (fillet, chamfer, extrusion…).
  for (const Input& in : inputs) {
    for (TopAbs_ShapeEnum type : {TopAbs_EDGE, TopAbs_VERTEX, TopAbs_FACE}) {
      TopTools_IndexedMapOfShape subs;
      TopExp::MapShapes(*in.shape, type, subs);
      std::vector<std::string> originNames;
      bool namesComputed = false;
      for (int i = 1; i <= subs.Extent(); i++) {
        if (!history.HasGenerated()) break;
        const TopTools_ListOfShape& gen = history.Generated(subs(i));
        for (const TopoDS_Shape& g : gen) {
          const int idx = resultFaces.FindIndex(g);
          if (idx == 0 || !cands[idx - 1].primary.empty()) continue;
          if (!namesComputed) {
            originNames = type == TopAbs_EDGE     ? in.names->edgeNames(*in.shape)
                          : type == TopAbs_VERTEX ? in.names->vertexNames(*in.shape)
                                                  : in.names->faceNames(*in.shape);
            namesComputed = true;
          }
          cands[idx - 1].aliases.push_back(generated(originNames[i - 1]));
        }
      }
    }
  }

  // 3. Name selection: the smallest candidate; the others become aliases.
  std::vector<std::string> names(n);
  std::vector<std::vector<std::string>> aliases(n);
  for (int i = 0; i < n; i++) {
    Candidates& c = cands[i];
    std::vector<std::string>& pool = c.primary.empty() ? c.aliases : c.primary;
    if (pool.empty()) pool.push_back(generated("?"));
    std::sort(pool.begin(), pool.end());
    pool.erase(std::unique(pool.begin(), pool.end()), pool.end());
    names[i] = pool.front();
    for (const std::string& s : c.primary)
      if (s != names[i]) aliases[i].push_back(s);
    for (const std::string& s : c.aliases)
      if (s != names[i]) aliases[i].push_back(s);
  }

  // 4. Split faces: homonyms told apart geometrically; the plain name remains an alias of the first piece.
  std::vector<Key> keys(n);
  for (int i = 0; i < n; i++) keys[i] = boxKey(resultFaces(i + 1));
  disambiguate(names, keys, [&](size_t idx, const std::string& plain) { aliases[idx].push_back(plain); });

  TopoNames out;
  for (int i = 0; i < n; i++) {
    out.set(resultFaces(i + 1), names[i]);
    for (std::string& a : aliases[i]) out.addAlias(resultFaces(i + 1), std::move(a));
  }

  // 5. Explicit names of free edges: they follow the edge kept or modified (a piece receives the same name,
  // then told apart by "#k" in edgeNames).
  TopTools_IndexedMapOfShape resultEdges;
  TopExp::MapShapes(result, TopAbs_EDGE, resultEdges);
  for (const Input& in : inputs)
    for (const auto& [edge, name] : in.names->edges_) {
      if (history.IsRemoved(edge)) continue;
      const TopTools_ListOfShape& modified = history.Modified(edge);
      if (modified.IsEmpty()) {
        if (resultEdges.Contains(edge)) out.setEdge(edge, name);
      } else {
        for (const TopoDS_Shape& m : modified)
          if (resultEdges.Contains(m)) out.setEdge(m, name);
      }
    }
  return out;
}

}  // namespace cad
