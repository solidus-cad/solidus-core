// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Surface analyses: curvature at the nodes of the display mesh, continuity along an edge between its two faces.
#pragma once

#include <TopoDS_Edge.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>

#include <string_view>
#include <vector>

namespace cad {

enum class CurvatureKind { Gaussian, Mean, Min, Max };

/// Kind from its name ("gaussian", "mean", "min", "max"); throws std::invalid_argument.
CurvatureKind curvatureKind(std::string_view name);

/// Curvature (mm⁻¹, mm⁻² for the Gaussian one) at each node of the triangulation of `shape`, in the order of the
/// vertices of tessellate() (faces in TopExp::MapShapes order, faces without triangulation skipped): one value per
/// vertex of the display mesh. Signs follow the orientation of the faces. NaN where the curvature is not defined.
std::vector<float> curvatureAtNodes(const TopoDS_Shape& shape, CurvatureKind kind);

/// Deviations between the two faces of an edge at a point of the edge: distance (G0, mm), angle of the normals
/// (G1, °), difference of the normal curvatures across the edge (G2, mm⁻¹).
struct ContinuitySample {
  gp_Pnt p;
  double g0, g1, g2;
};

/// `samples` points evenly spread along the edge (ends excluded). Throws std::runtime_error if the edge does not
/// separate two faces of `shape`.
std::vector<ContinuitySample> edgeContinuity(const TopoDS_Shape& shape, const TopoDS_Edge& edge, int samples = 21);

}  // namespace cad
