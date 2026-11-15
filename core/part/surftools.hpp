// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Tools shared by the surface features (solidify.cpp, surfedit.cpp): sewing of named surfaces, side of a point
// relative to a surface, offset, solid checks.
#pragma once

#include "part/builder.hpp"

#include <TopoDS_Face.hxx>
#include <TopoDS_Shell.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>

#include <limits>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace cad::surf {

/// Distance under which a point belongs to a surface or a cap.
constexpr double kOnShape = 1e-4;
/// Sewing tolerance: surfaces drawn on the same sketch points coincide to the kernel's precision.
constexpr double kSewing = 1e-3;

/// Face of a surface with the name it carries in its body.
struct NamedFace {
  TopoDS_Face face;
  std::string name;
};

/// Surfaces sewn along their common edges: the shape (shells and loose faces), its faces named after their origin, and
/// these names with those of the free edges.
struct Sewn {
  TopoDS_Shape shape;
  std::vector<NamedFace> faces;
  TopoNames names;
};

/// Closest point of a set of faces: index of the face, distance, normal of the face there (null if the closest point
/// is on an edge of the face: the point is beyond its boundary).
struct Foot {
  int index = -1;
  double distance = std::numeric_limits<double>::infinity();
  gp_Vec toPoint;
  gp_Vec normal;
  TopoDS_Shape support;
  bool onBoundary = false;
};

/// Counter of names: the second face carrying a name becomes "<name>#2", and so on.
class UniqueNames {
public:
  std::string operator()(const std::string& name) {
    const int k = ++seen_[name];
    return k == 1 ? name : name + "#" + std::to_string(k);
  }

private:
  std::map<std::string, int> seen_;
};

/// Identifiers of the surface bodies of the parameter `key` (at least one, all surfaces).
std::vector<std::string> surfaceIds(const BuildContext& ctx, std::string_view key);
std::vector<NamedFace> namedFaces(const Body& b);
/// Bodies `ids` sewn along their common edges, faces and explicit free edges keeping their names.
Sewn sew(const BuildContext& ctx, const std::vector<std::string>& ids, double tolerance = kSewing);
/// The only shell of a sewn shape; a single face is wrapped in a shell. Otherwise FeatureError(disjoint).
TopoDS_Shell singleShell(const TopoDS_Shape& shape, const char* disjoint);
double volumeOf(const TopoDS_Shape& s);
double areaOf(const TopoDS_Shape& s);
std::vector<TopoDS_Shape> solidsOf(const TopoDS_Shape& s);
/// A single valid solid, with its normals outward; null otherwise.
TopoDS_Shape validSolid(const TopoDS_Shape& s);
/// Point inside a face, and its parameters.
gp_Pnt innerPoint(const TopoDS_Face& face, gp_Pnt2d* uv = nullptr);
/// Normal of a face at parameters (u, v), following its orientation.
gp_Vec normalAt(const TopoDS_Face& face, const gp_Pnt2d& uv);
/// Closest point of `p` on a set of faces.
Foot footOn(const std::vector<NamedFace>& faces, const gp_Pnt& p);
/// Solid between a shell and its offset by `offset` (signed, along the normals).
TopoDS_Shape thickSolid(const TopoDS_Shell& shell, double offset);
/// Shell offset by `offset`, without thickness.
TopoDS_Shell offsetShell(const TopoDS_Shell& shell, double offset);

}  // namespace cad::surf
