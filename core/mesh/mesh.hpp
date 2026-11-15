// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Mesh of a body, with the layout of MeshPayload (packages/sdk/src/kernel.ts):
//  - positions, normals (xyz, float32), indices (uint32), one vertex set per face;
//  - faceGroups: triplets [start, count, id] as indices into `indices`; id = rank of the face (TopExp::MapShapes);
//  - edges: segments (two points per segment); edgeGroups: triplets [start, count, id] as points.
#pragma once

#include <TopoDS_Shape.hxx>

#include <cstdint>
#include <vector>

namespace cad {

struct MeshData {
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<uint32_t> indices;
  std::vector<int32_t> faceGroups;
  std::vector<float> edges;
  std::vector<int32_t> edgeGroups;

  void clear();
};

struct MeshOptions {
  /// Linear deflection; <= 0: proportional to the size of the part (diagonal x 5e-4, at least 1e-3).
  double deflection = 0;
  /// Angular deflection, in radians.
  double angularDeflection = 0.25;
  bool parallel = false;
};

/// Default deflection, proportional to the size of the part.
double defaultDeflection(const TopoDS_Shape& shape);

/// Meshes `shape` (BRepMesh) and fills `out`.
void tessellate(const TopoDS_Shape& shape, const MeshOptions& options, MeshData& out);

/// Meshes several bodies one after the other into `out`: face and edge identifiers are numbered body by body (index
/// in each body's own map, shifted by the counts of the bodies before it), like the names of the bodies put end to
/// end. A single compound would number shared sub-shapes once only (bodies sharing faces or edges, such as a
/// knitted solid and the surfaces it consumed), which shifts every following identifier.
void tessellateBodies(const std::vector<TopoDS_Shape>& bodies, const MeshOptions& options, MeshData& out);

}  // namespace cad
