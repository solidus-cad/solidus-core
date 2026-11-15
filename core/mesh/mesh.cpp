// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "mesh/mesh.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepBndLib.hxx>
#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_TangentialDeflection.hxx>
#include <Poly_Polygon3D.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>

#include <algorithm>
#include <cmath>

namespace cad {

void MeshData::clear() {
  positions.clear();
  normals.clear();
  indices.clear();
  faceGroups.clear();
  edges.clear();
  edgeGroups.clear();
}

double defaultDeflection(const TopoDS_Shape& shape) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box, false);
  const double diag = box.IsVoid() ? 100 : std::sqrt(box.SquareExtent());
  return std::max(diag * 5e-4, 1e-3);
}

namespace {

void pushPoint(std::vector<float>& v, const gp_Pnt& p) {
  v.push_back(float(p.X()));
  v.push_back(float(p.Y()));
  v.push_back(float(p.Z()));
}

void meshFaces(const TopoDS_Shape& shape, MeshData& out) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++) {
    const TopoDS_Face& face = TopoDS::Face(faces(i));
    TopLoc_Location loc;
    const Handle(Poly_Triangulation)& tri = BRep_Tool::Triangulation(face, loc);
    if (tri.IsNull() || tri->NbTriangles() == 0) continue;
    if (!tri->HasNormals()) BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri);
    const gp_Trsf trsf = loc.Transformation();
    const bool identity = loc.IsIdentity();
    const bool reversed = face.Orientation() == TopAbs_REVERSED;

    const uint32_t base = uint32_t(out.positions.size() / 3);
    const int32_t start = int32_t(out.indices.size());
    for (int n = 1; n <= tri->NbNodes(); n++) {
      gp_Pnt p = tri->Node(n);
      gp_Dir d = tri->Normal(n);
      if (!identity) {
        p.Transform(trsf);
        d.Transform(trsf);
      }
      if (reversed) d.Reverse();
      pushPoint(out.positions, p);
      out.normals.push_back(float(d.X()));
      out.normals.push_back(float(d.Y()));
      out.normals.push_back(float(d.Z()));
    }
    for (int t = 1; t <= tri->NbTriangles(); t++) {
      int a, b, c;
      tri->Triangle(t).Get(a, b, c);
      if (reversed) std::swap(b, c);
      out.indices.push_back(base + uint32_t(a - 1));
      out.indices.push_back(base + uint32_t(b - 1));
      out.indices.push_back(base + uint32_t(c - 1));
    }
    out.faceGroups.push_back(start);
    out.faceGroups.push_back(int32_t(out.indices.size()) - start);
    out.faceGroups.push_back(i - 1);
  }
}

/// Polyline of an edge: that of the mesh of an adjacent face (exact match with the triangles),
/// otherwise its 3D polygon, otherwise a discretization of the curve.
std::vector<gp_Pnt> edgePolyline(const TopoDS_Edge& edge, const TopTools_ListOfShape* faces, double tol, double angTol) {
  std::vector<gp_Pnt> pts;
  if (faces) {
    for (const TopoDS_Shape& f : *faces) {
      TopLoc_Location loc;
      const Handle(Poly_Triangulation)& tri = BRep_Tool::Triangulation(TopoDS::Face(f), loc);
      if (tri.IsNull()) continue;
      Handle(Poly_PolygonOnTriangulation) poly = BRep_Tool::PolygonOnTriangulation(edge, tri, loc);
      if (poly.IsNull()) continue;
      const gp_Trsf trsf = loc.Transformation();
      for (int k = 1; k <= poly->NbNodes(); k++) pts.push_back(tri->Node(poly->Node(k)).Transformed(trsf));
      return pts;
    }
  }
  TopLoc_Location loc;
  Handle(Poly_Polygon3D) p3 = BRep_Tool::Polygon3D(edge, loc);
  if (!p3.IsNull()) {
    const gp_Trsf trsf = loc.Transformation();
    for (int k = 1; k <= p3->NbNodes(); k++) pts.push_back(p3->Nodes().Value(k).Transformed(trsf));
    return pts;
  }
  BRepAdaptor_Curve curve(edge);
  GCPnts_TangentialDeflection d(curve, angTol, tol);
  for (int k = 1; k <= d.NbPoints(); k++) pts.push_back(d.Value(k));
  return pts;
}

void meshEdges(const TopoDS_Shape& shape, double tol, double angTol, MeshData& out) {
  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes(shape, TopAbs_EDGE, edges);
  TopTools_IndexedDataMapOfShapeListOfShape adjacency;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, adjacency);
  for (int i = 1; i <= edges.Extent(); i++) {
    const TopoDS_Edge& edge = TopoDS::Edge(edges(i));
    if (BRep_Tool::Degenerated(edge)) continue;
    const std::vector<gp_Pnt> pts = edgePolyline(edge, adjacency.Seek(edge), tol, angTol);
    if (pts.size() < 2) continue;
    const int32_t start = int32_t(out.edges.size() / 3);
    for (size_t k = 0; k + 1 < pts.size(); k++) {
      pushPoint(out.edges, pts[k]);
      pushPoint(out.edges, pts[k + 1]);
    }
    out.edgeGroups.push_back(start);
    out.edgeGroups.push_back(int32_t(out.edges.size() / 3) - start);
    out.edgeGroups.push_back(i - 1);
  }
}

}  // namespace

void tessellate(const TopoDS_Shape& shape, const MeshOptions& options, MeshData& out) {
  out.clear();
  const double tol = options.deflection > 0 ? options.deflection : defaultDeflection(shape);
  BRepMesh_IncrementalMesh mesher(shape, tol, false, options.angularDeflection, options.parallel);
  meshFaces(shape, out);
  meshEdges(shape, tol, options.angularDeflection, out);
}

void tessellateBodies(const std::vector<TopoDS_Shape>& bodies, const MeshOptions& options, MeshData& out) {
  out.clear();
  if (bodies.empty()) return;
  MeshOptions opts = options;
  // One deflection for all the bodies: that of the whole part, as with a single compound.
  if (opts.deflection <= 0) {
    TopoDS_Compound all;
    BRep_Builder builder;
    builder.MakeCompound(all);
    for (const TopoDS_Shape& b : bodies) builder.Add(all, b);
    opts.deflection = defaultDeflection(all);
  }
  int32_t faces = 0, edges = 0;
  MeshData part;
  for (const TopoDS_Shape& body : bodies) {
    tessellate(body, opts, part);
    const uint32_t base = uint32_t(out.positions.size() / 3);
    const int32_t indexBase = int32_t(out.indices.size());
    const int32_t pointBase = int32_t(out.edges.size() / 3);
    out.positions.insert(out.positions.end(), part.positions.begin(), part.positions.end());
    out.normals.insert(out.normals.end(), part.normals.begin(), part.normals.end());
    for (const uint32_t i : part.indices) out.indices.push_back(base + i);
    for (size_t k = 0; k + 2 < part.faceGroups.size(); k += 3) {
      out.faceGroups.push_back(indexBase + part.faceGroups[k]);
      out.faceGroups.push_back(part.faceGroups[k + 1]);
      out.faceGroups.push_back(faces + part.faceGroups[k + 2]);
    }
    out.edges.insert(out.edges.end(), part.edges.begin(), part.edges.end());
    for (size_t k = 0; k + 2 < part.edgeGroups.size(); k += 3) {
      out.edgeGroups.push_back(pointBase + part.edgeGroups[k]);
      out.edgeGroups.push_back(part.edgeGroups[k + 1]);
      out.edgeGroups.push_back(edges + part.edgeGroups[k + 2]);
    }
    TopTools_IndexedMapOfShape map;
    TopExp::MapShapes(body, TopAbs_FACE, map);
    faces += map.Extent();
    map.Clear();
    TopExp::MapShapes(body, TopAbs_EDGE, map);
    edges += map.Extent();
  }
}

}  // namespace cad
